// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  // How far this view has caught up. Persisted through setState because a
  // reloaded webview loses its DOM while the task keeps running in the
  // extension host — on the next 'ready' this is what lets it ask for the
  // gap instead of restarting anything.
  let lastSequence = 0;
  try {
    const saved = vscode.getState();
    if (saved && typeof saved.lastSequence === 'number') lastSequence = saved.lastSequence;
  } catch (e) {
    /* no persisted state; start from zero */
  }

  function rememberSequence(n) {
    if (typeof n !== 'number' || n <= lastSequence) return;
    lastSequence = n;
    try {
      vscode.setState({ lastSequence: lastSequence });
    } catch (e) {
      /* state is a convenience, never a requirement */
    }
  }

  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stop'));
  const attachEl = /** @type {HTMLInputElement} */ (document.getElementById('attachContext'));
  const bannerEl = document.getElementById('banner');
  const attachBtn = document.getElementById('attach');
  const attachmentsEl = document.getElementById('attachments');
  const modeEl = /** @type {HTMLSelectElement} */ (document.getElementById('mode'));
  const modelEl = /** @type {HTMLSelectElement} */ (document.getElementById('model'));
  const effortEl = /** @type {HTMLSelectElement} */ (document.getElementById('effort'));
  const noticesEl = document.getElementById('notices');
  const historyPanel = document.getElementById('historyPanel');
  const historyList = document.getElementById('historyList');
  const historyFolder = document.getElementById('historyFolder');
  const historyClose = document.getElementById('historyClose');

  /** @type {{el: HTMLElement, body: HTMLElement, raw: string} | null} */
  let current = null;
  /** @type {{el: HTMLElement, body: HTMLElement, raw: string} | null} */
  let currentThinking = null;
  let busy = false;
  let pendingRender = false;
  let pendingThinkingRender = false;
  let attachmentCount = 0;

  // ---------- helpers ----------

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmpty() {
    if (emptyEl && !emptyEl.classList.contains('hidden')) {
      emptyEl.classList.add('hidden');
    }
  }

  function setBusy(v) {
    busy = v;
    sendBtn.classList.toggle('hidden', v);
    stopBtn.classList.toggle('hidden', !v);
    inputEl.disabled = false;
  }

  // ---------- minimal, escaping-by-construction markdown ----------

  /** Renders inline markdown into a parent node using text nodes only. */
  function renderInline(parent, text) {
    // Order matters: code spans first so their contents are not re-parsed.
    const pattern = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const tok = m[0];
      if (tok.startsWith('`')) {
        parent.appendChild(el('code', null, tok.slice(1, -1)));
      } else if (tok.startsWith('**')) {
        parent.appendChild(el('strong', null, tok.slice(2, -2)));
      } else if (tok.startsWith('[')) {
        const close = tok.indexOf('](');
        parent.appendChild(el('span', null, tok.slice(1, close)));
      } else {
        parent.appendChild(el('em', null, tok.slice(1, -1)));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function makeCodeBlock(lang, code) {
    const wrap = el('div', 'codeblock');
    const head = el('div', 'cb-head');
    head.appendChild(el('span', null, lang || 'text'));
    head.appendChild(el('span', 'spacer'));

    const copy = el('button', 'tiny secondary', 'Copy');
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text: code });
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    const insert = el('button', 'tiny secondary', 'Insert');
    insert.title = 'Replace the current editor selection with this code';
    insert.addEventListener('click', () =>
      vscode.postMessage({ type: 'insertAtCursor', text: code })
    );

    head.appendChild(copy);
    head.appendChild(insert);

    const pre = el('pre');
    pre.appendChild(el('code', null, code));
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderMarkdown(container, src) {
    container.textContent = '';
    const lines = src.split('\n');
    let i = 0;
    /** @type {HTMLElement|null} */
    let list = null;

    const closeList = () => { list = null; };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^\s*```(\S*)\s*$/);
      if (fence) {
        closeList();
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // consume closing fence (may be absent while streaming)
        container.appendChild(makeCodeBlock(lang, buf.join('\n')));
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        const h = el('h' + Math.min(4, heading[1].length + 2));
        renderInline(h, heading[2]);
        container.appendChild(h);
        i++;
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const wantOl = Boolean(numbered);
        if (!list || (list.tagName === 'OL') !== wantOl) {
          list = el(wantOl ? 'ol' : 'ul');
          container.appendChild(list);
        }
        const li = el('li');
        renderInline(li, (bullet ? bullet[1] : numbered[1]));
        list.appendChild(li);
        i++;
        continue;
      }

      if (line.trim() === '') {
        closeList();
        i++;
        continue;
      }

      // paragraph: gather consecutive non-special lines
      closeList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s*```/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !/^#{1,4}\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      const p = el('p');
      renderInline(p, para.join(' '));
      container.appendChild(p);
    }
  }

  function scheduleRender() {
    if (pendingRender || !current) return;
    pendingRender = true;
    requestAnimationFrame(() => {
      pendingRender = false;
      if (!current) return;
      const nearBottom =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      renderMarkdown(current.body, current.raw);
      if (nearBottom) scrollToBottom();
    });
  }

  // ---------- message blocks ----------

  function addUserMessage(text, attachments) {
    hideEmpty();
    const wrap = el('div', 'msg user');
    wrap.appendChild(el('div', 'role', 'You'));
    renderUserAttachments(wrap, attachments);
    const body = el('div');
    renderMarkdown(body, text);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function startAssistant() {
    hideEmpty();
    const wrap = el('div', 'msg assistant');
    wrap.appendChild(el('div', 'role', 'Assistant'));
    const body = el('div');
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    current = { el: wrap, body, raw: '' };
    scrollToBottom();
  }

  function finishAssistant() {
    if (current) {
      renderMarkdown(current.body, current.raw);
      if (current.raw.trim() === '') {
        current.el.remove();
      }
    }
    current = null;
  }

  function addTool(name, args) {
    hideEmpty();
    const row = el('div', 'tool');
    row.appendChild(el('span', 'dot'));
    const label = el('span');
    label.appendChild(document.createTextNode(prettyToolName(name)));
    if (args) {
      label.appendChild(document.createTextNode(' '));
      label.appendChild(el('code', null, args));
    }
    row.appendChild(label);
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function prettyToolName(name) {
    switch (name) {
      case 'read_file': return 'Reading';
      case 'list_files': return 'Listing';
      case 'search_workspace': return 'Searching';
      case 'write_file': return 'Preparing edit';
      case 'get_diagnostics': return 'Checking problems';
      case 'record_session': return 'Recording';
      case 'run_command': return 'Ran';
      case 'git_status': return 'Git status';
      case 'git_diff': return 'Git diff';
      case 'run_validation': return 'Validation';
      default: return name;
    }
  }

  function addEditCard(info) {
    hideEmpty();
    const card = el('div', 'edit-card');
    card.dataset.editId = info.id;

    card.appendChild(el('div', 'file', info.relPath + (info.isNewFile ? '  (new file)' : '')));

    const stat = el('div', 'stat');
    stat.appendChild(el('span', 'add', '+' + info.added));
    stat.appendChild(document.createTextNode('  '));
    stat.appendChild(el('span', 'del', '−' + info.removed));
    card.appendChild(stat);

    if (info.id === 'auto') {
      const v = el('div', 'verdict', 'Applied automatically (auto-approve is on).');
      card.appendChild(v);
      card.classList.add('resolved');
      messagesEl.appendChild(card);
      scrollToBottom();
      return;
    }

    const row = el('div', 'row');
    const accept = el('button', null, 'Apply');
    accept.addEventListener('click', () =>
      vscode.postMessage({ type: 'acceptEdit', id: info.id })
    );
    const reject = el('button', 'secondary', 'Discard');
    reject.addEventListener('click', () =>
      vscode.postMessage({ type: 'rejectEdit', id: info.id })
    );
    const diff = el('button', 'secondary', 'View diff');
    diff.addEventListener('click', () =>
      vscode.postMessage({ type: 'openDiff', id: info.id })
    );
    row.appendChild(accept);
    row.appendChild(reject);
    row.appendChild(diff);
    card.appendChild(row);

    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function resolveEditCard(id, decision) {
    const card = messagesEl.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('resolved');
    card.appendChild(
      el(
        'div',
        'verdict',
        decision === 'accepted' ? 'Applied to the file.' : 'Discarded — file unchanged.'
      )
    );
  }

  function expireEditCard(id) {
    const card = messagesEl.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
    if (!card || card.classList.contains('resolved')) return;
    card.classList.add('resolved');
    card.appendChild(
      el('div', 'verdict', 'No longer available — this edit was cancelled. The file is unchanged.')
    );
  }


  // ---------- attachments ----------

  const KIND_ICON = { image: '\u25a3', document: '\u2637', text: '\u2261', unsupported: '\u26a0' };

  function renderAttachments(items) {
    attachmentCount = items.length;
    attachmentsEl.textContent = '';
    attachmentsEl.classList.toggle('hidden', items.length === 0);

    items.forEach(item => {
      const chip = el('div', 'chip' + (item.error ? ' bad' : ''));
      chip.appendChild(el('span', 'chip-icon', KIND_ICON[item.kind] || '\u2261'));

      const label = el('span', 'chip-name', item.name);
      label.title = item.error
        ? item.error
        : item.name + ' — ' + item.size + (item.note ? ' (' + item.note + ')' : '') +
          (item.chars ? ' · ' + item.chars.toLocaleString() + ' chars read' : '');
      chip.appendChild(label);

      const detail = item.error ? 'unreadable' : (item.kind === 'image' ? item.size : (item.note || item.size));
      chip.appendChild(el('span', 'chip-meta', detail));

      const x = el('button', 'chip-x', '\u00d7');
      x.title = 'Remove';
      x.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: item.id }));
      chip.appendChild(x);

      attachmentsEl.appendChild(chip);
    });
  }

  function renderUserAttachments(parent, items) {
    if (!items || !items.length) return;
    const row = el('div', 'msg-attachments');
    items.forEach(item => {
      const chip = el('span', 'chip small' + (item.error ? ' bad' : ''));
      chip.appendChild(el('span', 'chip-icon', KIND_ICON[item.kind] || '\u2261'));
      chip.appendChild(el('span', 'chip-name', item.name));
      if (item.error) chip.title = item.error;
      row.appendChild(chip);
    });
    parent.appendChild(row);
  }

  // ---------- thinking ----------

  function startThinking() {
    hideEmpty();
    const wrap = el('details', 'thinking-block');
    const summary = el('summary', null, 'Thinking\u2026');
    wrap.appendChild(summary);
    const body = el('div', 'thinking-body');
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    currentThinking = { el: wrap, body, raw: '' };
    scrollToBottom();
  }

  function finishThinking() {
    if (currentThinking) {
      const s = currentThinking.el.querySelector('summary');
      if (s) s.textContent = 'Thought for a moment';
      if (!currentThinking.raw.trim()) currentThinking.el.remove();
    }
    currentThinking = null;
  }

  function scheduleThinkingRender() {
    if (pendingThinkingRender || !currentThinking) return;
    pendingThinkingRender = true;
    requestAnimationFrame(() => {
      pendingThinkingRender = false;
      if (!currentThinking) return;
      currentThinking.body.textContent = currentThinking.raw;
      scrollToBottom();
    });
  }

  // ---------- command cards ----------

  function addCommandCard(info) {
    hideEmpty();
    const card = el('div', 'cmd-card');
    card.dataset.cmdId = info.id;

    const head = el('div', 'cmd-head');
    head.appendChild(el('span', 'cmd-label', info.autoRun ? 'Running' : 'Wants to run'));
    head.appendChild(el('span', 'spacer'));
    head.appendChild(el('span', 'cmd-cwd', info.cwd));
    card.appendChild(head);

    const pre = el('pre', 'cmd-line');
    pre.appendChild(el('code', null, info.command));
    card.appendChild(pre);

    if (!info.autoRun) {
      card.appendChild(el('div', 'cmd-reason', info.reason));
      const row = el('div', 'row');
      const run = el('button', null, 'Run');
      run.addEventListener('click', () => vscode.postMessage({ type: 'approveCommand', id: info.id }));
      const skip = el('button', 'secondary', 'Skip');
      skip.addEventListener('click', () => vscode.postMessage({ type: 'rejectCommand', id: info.id }));
      row.appendChild(run);
      row.appendChild(skip);
      card.appendChild(row);
    } else {
      card.classList.add('auto');
    }

    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function resolveCommandCard(id, decision) {
    const card = messagesEl.querySelector(`[data-cmd-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('resolved');
    const row = card.querySelector('.row');
    if (row) row.remove();
    if (decision === 'rejected') {
      card.appendChild(el('div', 'verdict', 'Skipped \u2014 the command did not run.'));
    }
  }

  function expireCommandCard(id) {
    const card = messagesEl.querySelector(`[data-cmd-id="${CSS.escape(id)}"]`);
    if (!card || card.classList.contains('resolved')) return;
    card.classList.add('resolved');
    const row = card.querySelector('.row');
    if (row) row.remove();
    card.appendChild(el('div', 'verdict', 'No longer available \u2014 this was cancelled.'));
  }

  function finishCommandCard(info) {
    const card = messagesEl.querySelector(`[data-cmd-id="${CSS.escape(info.id)}"]`);
    if (!card) return;
    card.classList.add('resolved');
    const row = card.querySelector('.row');
    if (row) row.remove();

    const ok = info.exitCode === 0;
    const status = el('div', 'cmd-status');
    status.appendChild(el('span', 'badge ' + (ok ? 'ok' : 'bad'),
      info.timedOut ? 'timed out' : (info.exitCode === null ? 'no exit code' : 'exit ' + info.exitCode)));
    status.appendChild(el('span', 'cmd-time', info.durationMs + ' ms'));
    card.appendChild(status);

    if (info.output && info.output.trim()) {
      const out = el('details', 'cmd-output');
      out.appendChild(el('summary', null, 'Output'));
      const pre = el('pre');
      pre.appendChild(el('code', null, info.output.trim()));
      out.appendChild(pre);
      card.appendChild(out);
    }
    scrollToBottom();
  }


  // ---------- history ----------

  function closeHistory() {
    historyPanel.classList.add('hidden');
    vscode.postMessage({ type: 'closeHistory' });
  }

  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function renderHistory(payload) {
    historyPanel.classList.remove('hidden');
    historyList.textContent = '';

    historyFolder.textContent = payload.folder ? 'Saved on this machine in ' + payload.folder : '';

    if (!payload.items || payload.items.length === 0) {
      historyList.appendChild(el('div', 'history-empty',
        'No saved conversations yet. They appear here once you send a message.'));
      return;
    }

    payload.items.forEach(item => {
      const row = el('div', 'history-item' + (item.id === payload.currentId ? ' current' : ''));

      const main = el('button', 'history-open');
      main.appendChild(el('div', 'history-title', item.title));
      const meta = el('div', 'history-meta');
      meta.appendChild(el('span', null, relativeTime(item.updatedAt)));
      meta.appendChild(el('span', 'dotsep', '\u00b7'));
      meta.appendChild(el('span', null, item.messageCount + ' messages'));
      if (item.workspace) {
        meta.appendChild(el('span', 'dotsep', '\u00b7'));
        meta.appendChild(el('span', null, item.workspace));
      }
      if (item.model) {
        meta.appendChild(el('span', 'dotsep', '\u00b7'));
        meta.appendChild(el('span', null, item.model));
      }
      main.appendChild(meta);
      main.addEventListener('click', () =>
        vscode.postMessage({ type: 'loadConversation', id: item.id }));
      row.appendChild(main);

      const del = el('button', 'history-del', '\u00d7');
      del.title = 'Delete this conversation';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteConversation', id: item.id });
      });
      row.appendChild(del);

      historyList.appendChild(row);
    });
  }

  // ---------- restoring a stored conversation ----------

  function restore(payload) {
    messagesEl.textContent = '';
    current = null;
    currentThinking = null;
    renderAttachments([]);
    setBusy(false);
    historyPanel.classList.add('hidden');

    if (payload.model) {
      const opt = [...modelEl.options].find(o => o.value === payload.model);
      if (opt) modelEl.value = payload.model;
    }

    (payload.turns || []).forEach(turn => {
      if (turn.role === 'user') {
        addUserMessage(turn.text);
      } else if (turn.role === 'assistant') {
        startAssistant();
        current.raw = turn.text;
        renderMarkdown(current.body, current.raw);
        current = null;
      } else if (turn.role === 'tool') {
        addTool(turn.tool, turn.detail);
      }
    });

    messagesEl.appendChild(el('div', 'resumed',
      'Continuing this conversation. Earlier file and command output is summarised above; the assistant still has the full transcript.'));
    scrollToBottom();
  }

  // ---------- notices ----------

  function addNotice(message) {
    const note = el('div', 'notice');
    note.appendChild(el('span', null, message));
    const x = el('button', 'notice-x', '\u00d7');
    x.addEventListener('click', () => note.remove());
    note.appendChild(x);
    noticesEl.appendChild(note);
    setTimeout(() => note.remove(), 20000);
  }

  function addError(message) {
    hideEmpty();
    messagesEl.appendChild(el('div', 'err', message));
    scrollToBottom();
  }

  function populateModels(models) {
    const previous = modelEl.value;
    modelEl.textContent = '';
    if (!models.length) {
      const opt = el('option', null, 'No model configured');
      opt.value = '';
      modelEl.appendChild(opt);
      modelEl.disabled = true;
      return;
    }
    modelEl.disabled = false;
    models.forEach(name => {
      const opt = el('option', null, name);
      opt.value = name;
      modelEl.appendChild(opt);
    });
    modelEl.value = models.includes(previous) ? previous : models[0];
  }

  /** Modes come from the extension so the labels never drift from MODE_PROFILES. */
  function populateModes(modes, fallback) {
    const previous = modeEl.dataset.touched ? modeEl.value : '';
    modeEl.textContent = '';
    modes.forEach(item => {
      const opt = el('option', null, 'Mode: ' + item.label);
      opt.value = item.mode;
      opt.title = item.description;
      modeEl.appendChild(opt);
    });
    const wanted = previous || fallback;
    if (wanted && modes.some(item => item.mode === wanted)) modeEl.value = wanted;
  }

  function showBanner(payload) {
    bannerEl.textContent = '';
    if (payload.configured) {
      bannerEl.classList.add('hidden');
      return;
    }
    bannerEl.classList.remove('hidden');
    bannerEl.appendChild(
      el(
        'div',
        null,
        'Not connected yet. Set your Azure OpenAI endpoint and deployment name, then add your API key.'
      )
    );
    const openSettings = el('button', 'tiny', 'Open settings');
    openSettings.addEventListener('click', () =>
      vscode.postMessage({ type: 'openSettings' })
    );
    const setKey = el('button', 'tiny secondary', 'Set API key');
    setKey.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    bannerEl.appendChild(openSettings);
    bannerEl.appendChild(setKey);
  }

  // ---------- send / receive ----------

  function send() {
    const text = inputEl.value.trim();
    if ((!text && attachmentCount === 0) || busy) return;
    inputEl.value = '';
    setBusy(true);
    vscode.postMessage({
      type: 'send',
      text: text || 'Please review the attached file(s).',
      attachContext: attachEl.checked,
      model: modelEl.value,
      mode: modeEl.value,
      reasoningEffort: effortEl.value
    });
  }

  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
  historyClose.addEventListener('click', closeHistory);
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));


  effortEl.addEventListener('change', () => { effortEl.dataset.touched = '1'; });
  modeEl.addEventListener('change', () => { modeEl.dataset.touched = '1'; });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    rememberSequence(m.sequence);
    switch (m.type) {
      case 'status':
        showBanner(m);
        populateModels(m.models || []);
        populateModes(m.modes || [], m.defaultMode);
        if (m.defaultEffort && !effortEl.dataset.touched) effortEl.value = m.defaultEffort;
        break;
      case 'userMessage':
        addUserMessage(m.text, m.attachments);
        break;
      case 'attachments':
        renderAttachments(m.items || []);
        break;
      case 'history':
        renderHistory(m);
        break;
      case 'restore':
        restore(m);
        break;
      case 'notice':
        addNotice(m.message);
        break;
      case 'attachmentsCleared':
        renderAttachments([]);
        break;
      case 'attachmentsLoading':
        attachmentsEl.classList.remove('hidden');
        attachmentsEl.textContent = '';
        attachmentsEl.appendChild(el('span', 'chip loading', 'Reading ' + m.count + ' file(s)\u2026'));
        break;
      case 'reasoningDelta':
        if (!currentThinking) startThinking();
        currentThinking.raw += m.delta;
        scheduleThinkingRender();
        break;
      case 'commandProposed':
        finishAssistant();
        finishThinking();
        addCommandCard(m);
        break;
      case 'commandResolved':
        resolveCommandCard(m.id, m.decision);
        break;
      case 'commandExpired':
        expireCommandCard(m.id);
        break;
      case 'commandFinished':
        finishCommandCard(m);
        break;
      case 'contextAttached': {
        const users = messagesEl.querySelectorAll('.msg.user');
        const last = users[users.length - 1];
        if (last) {
          const chip = el('div', 'ctxchip', '@ ' + m.label);
          last.insertBefore(chip, last.children[1] || null);
        }
        break;
      }
      case 'assistantStart':
        finishAssistant();
        finishThinking();
        startAssistant();
        break;
      case 'assistantDelta':
        if (!current) startAssistant();
        current.raw += m.delta;
        scheduleRender();
        break;
      case 'toolStart':
        finishAssistant();
        finishThinking();
        if (m.name !== 'run_command' && m.name !== 'git_status' &&
            m.name !== 'git_diff' && m.name !== 'run_validation') {
          addTool(m.name, m.args);
        }
        break;
      case 'toolEnd':
        break;
      case 'editProposed':
        finishAssistant();
        addEditCard(m);
        break;
      case 'editResolved':
        resolveEditCard(m.id, m.decision);
        break;
      case 'editExpired':
        expireEditCard(m.id);
        break;
      case 'done':
        finishAssistant();
        finishThinking();
        if (m.usageNote) {
          messagesEl.appendChild(el('div', 'thinking', m.usageNote));
          scrollToBottom();
        }
        setBusy(false);
        break;
      case 'cancelled':
        finishAssistant();
        finishThinking();
        setBusy(false);
        messagesEl.appendChild(el('div', 'thinking', 'Stopped.'));
        scrollToBottom();
        break;
      case 'error':
        finishAssistant();
        finishThinking();
        addError(m.message);
        setBusy(false);
        break;
      case 'cleared':
        // A new conversation is a new task: nothing to catch up on.
        lastSequence = 0;
        try { vscode.setState({ lastSequence: 0 }); } catch (e) { /* ignore */ }
        historyPanel.classList.add('hidden');
        noticesEl.textContent = '';
        renderAttachments([]);
        currentThinking = null;
        messagesEl.textContent = '';
        messagesEl.appendChild(emptyEl);
        emptyEl.classList.remove('hidden');
        current = null;
        setBusy(false);
        break;
      case 'prefill':
        inputEl.value = m.text;
        inputEl.focus();
        if (m.autosend) send();
        break;
    }
  });

  setBusy(false);
  vscode.postMessage({ type: 'ready', lastSequence: lastSequence });
})();
