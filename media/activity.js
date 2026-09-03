// @ts-check
(function () {
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;

  /** @type {{root: HTMLElement, summary: HTMLElement, list: HTMLElement, rows: Map<string, HTMLElement>, startedAt: number, eventCount: number} | null} */
  let stream = null;
  let earlierUserTurns = 0;
  /** @type {Set<string>} */
  const knownFiles = new Set();
  /** @type {Map<string, string[]>} */
  const runningTools = new Map();
  let modelRound = 0;
  let answerStarted = false;
  let reasoningStarted = false;
  let phase = '';

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function scrollIfNearBottom() {
    const nearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startStream(message) {
    const root = node('details', 'activity-stream');
    root.open = true;
    const summary = node('summary');
    const spinner = node('span', 'activity-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    summary.appendChild(spinner);
    summary.appendChild(
      node('span', 'activity-summary', phase ? phase + '…' : 'Working…')
    );
    root.appendChild(summary);

    const safety = node(
      'div',
      'activity-safety',
      'Live operational events and model-provided reasoning summaries are shown here. Private chain-of-thought is not exposed.'
    );
    root.appendChild(safety);
    const list = node('div', 'activity-events');
    root.appendChild(list);
    messagesEl.appendChild(root);

    stream = {
      root,
      summary: /** @type {HTMLElement} */ (summary.querySelector('.activity-summary')),
      list,
      rows: new Map(),
      startedAt: Date.now(),
      eventCount: 0
    };
    runningTools.clear();
    modelRound = 0;
    answerStarted = false;
    reasoningStarted = false;

    addEvent('request', 'done', 'Request received', message || 'Preparing context and contacting Azure OpenAI.');
    if (earlierUserTurns > 0) {
      const files = [...knownFiles];
      const fileDetail = files.length
        ? ` Previously referenced: ${files.slice(-5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`
        : '';
      addEvent(
        'history',
        'info',
        'Conversation history included',
        `${earlierUserTurns} earlier user turn${earlierUserTurns === 1 ? '' : 's'} remain in the model context.${fileDetail}`
      );
    } else {
      addEvent('history', 'info', 'New conversation', 'No earlier conversation turns were included.');
    }
    earlierUserTurns += 1;
    scrollIfNearBottom();
  }

  function addEvent(id, state, title, detail) {
    if (!stream) return;
    let row = stream.rows.get(id);
    if (!row) {
      row = node('div', `activity-event ${state}`);
      row.appendChild(node('span', 'activity-state'));
      const content = node('div', 'activity-content');
      content.appendChild(node('div', 'activity-title'));
      content.appendChild(node('div', 'activity-detail'));
      row.appendChild(content);
      stream.list.appendChild(row);
      stream.rows.set(id, row);
      stream.eventCount += 1;
    }
    row.className = `activity-event ${state}`;
    const titleEl = row.querySelector('.activity-title');
    const detailEl = row.querySelector('.activity-detail');
    if (titleEl) titleEl.textContent = title;
    if (detailEl) {
      detailEl.textContent = detail || '';
      detailEl.classList.toggle('hidden', !detail);
    }
    scrollIfNearBottom();
  }

  function finishStream(status, detail) {
    if (!stream) return;
    const elapsed = ((Date.now() - stream.startedAt) / 1000).toFixed(1);
    stream.root.classList.remove('running');
    stream.root.classList.add(status);
    const spinner = stream.root.querySelector('.activity-spinner');
    if (spinner) spinner.remove();
    const label = status === 'done' ? 'Completed' : status === 'cancelled' ? 'Stopped' : 'Failed';
    stream.summary.textContent = `${label} in ${elapsed}s · ${stream.eventCount} events${detail ? ` · ${detail}` : ''}`;
    stream.root.open = status !== 'done';
    stream = null;
    runningTools.clear();
  }

  function describeAttachment(item) {
    if (item.error) return `Could not be read: ${item.error}`;
    if (item.kind === 'image') return `${item.size} image supplied to the vision request.`;
    const type = item.kind === 'document' ? 'document text extracted locally' : 'text read locally';
    const amount = item.chars ? `${Number(item.chars).toLocaleString()} characters` : item.size;
    return `${amount}; ${type}${item.note ? `; ${item.note}` : ''}.`;
  }

  function toolTitle(name, args) {
    switch (name) {
      case 'read_file': return [`Reading workspace file ${args || ''}`.trim(), 'The model requested current file contents from the workspace.'];
      case 'list_files': return [`Listing files ${args || ''}`.trim(), 'Inspecting the current workspace structure.'];
      case 'search_workspace': return [`Searching workspace ${args || ''}`.trim(), 'Looking for relevant implementations and references.'];
      case 'get_diagnostics': return [`Checking diagnostics ${args || ''}`.trim(), 'Reading current editor and language-service problems.'];
      case 'git_status': return ['Checking Git status', 'Inspecting the branch and uncommitted work.'];
      case 'git_diff': return [`Reviewing Git diff ${args || ''}`.trim(), 'Reviewing changes before reporting completion.'];
      case 'run_validation': return ['Running project validation', 'Executing the checks discovered from project configuration.'];
      case 'run_command': return [`Running command ${args || ''}`.trim(), 'Executing through the configured command safety policy.'];
      case 'write_file': return [`Preparing file change ${args || ''}`.trim(), 'Building a complete replacement for review; no write occurs until approved.'];
      case 'record_session': return ['Recording session context', 'Saving a concise, redacted engineering note for later sessions.'];
      default: return [`Using ${name}`, args || 'Running an assistant tool.'];
    }
  }

  function completeTool(name, preview) {
    if (!stream) return;
    const ids = runningTools.get(name) || [];
    const id = ids.shift();
    if (!id) return;
    if (ids.length === 0) runningTools.delete(name);
    const row = stream.rows.get(id);
    const currentTitle = row?.querySelector('.activity-title')?.textContent || `Completed ${name}`;
    let detail = preview ? preview.replace(/\s+/g, ' ').trim() : 'Completed.';
    if (detail.length > 180) detail = detail.slice(0, 177) + '…';
    addEvent(id, /^error\b/i.test(detail) ? 'warning' : 'done', currentTitle, detail);
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'userMessage': {
        // Let the primary UI listener render the user message first, then place
        // this request's activity immediately below it.
        queueMicrotask(() => {
          startStream(message.text ? `“${String(message.text).slice(0, 100)}${String(message.text).length > 100 ? '…' : ''}”` : 'Attachment review requested.');
          (message.attachments || []).forEach((item) => {
            knownFiles.add(String(item.name));
            addEvent(`attachment-${item.id}`, item.error ? 'warning' : 'done', `Attached context: ${item.name}`, describeAttachment(item));
          });
        });
        break;
      }
      case 'contextAttached':
        knownFiles.add(String(message.label));
        addEvent('active-context', 'done', `Active editor context: ${message.label}`, 'Current editor contents were included with this request.');
        break;
      case 'agentState': {
        const label = String(message.label || '');
        const terminal =
          message.state === 'idle' ||
          message.state === 'completed' ||
          message.state === 'failed' ||
          message.state === 'cancelled';
        if (terminal) {
          phase = '';
        } else if (label) {
          phase = label;
          if (stream) stream.summary.textContent = label + '…';
        }
        break;
      }
      case 'assistantStart':
        modelRound += 1;
        addEvent(`model-${modelRound}`, 'running', modelRound === 1 ? 'Azure response stream opened' : `Azure response stream resumed · round ${modelRound}`, 'Waiting for streamed text or a tool decision.');
        break;
      case 'reasoningDelta':
        if (!reasoningStarted) {
          reasoningStarted = true;
          addEvent('reasoning', 'running', 'Reasoning summary streaming', 'This is the summary explicitly returned by the deployment, not hidden chain-of-thought.');
        }
        break;
      case 'assistantDelta':
        if (!answerStarted) {
          answerStarted = true;
          addEvent('answer', 'running', 'Answer streaming', 'Response text is arriving incrementally from Azure OpenAI.');
        }
        break;
      case 'toolStart': {
        const titleAndDetail = toolTitle(String(message.name), String(message.args || ''));
        const id = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const ids = runningTools.get(String(message.name)) || [];
        ids.push(id);
        runningTools.set(String(message.name), ids);
        addEvent(id, 'running', titleAndDetail[0], titleAndDetail[1]);
        if (message.name === 'read_file' && message.args) knownFiles.add(String(message.args));
        break;
      }
      case 'toolEnd':
        completeTool(String(message.name), String(message.preview || ''));
        break;
      case 'done':
        if (stream) {
          for (const row of stream.list.querySelectorAll('.activity-event.running')) row.classList.replace('running', 'done');
        }
        finishStream('done', message.usageNote || '');
        break;
      case 'cancelled':
        finishStream('cancelled', 'cancelled by user');
        break;
      case 'error':
        finishStream('error', 'see error below');
        break;
      case 'restore': {
        const turns = Array.isArray(message.turns) ? message.turns : [];
        earlierUserTurns = turns.filter((turn) => turn.role === 'user').length;
        knownFiles.clear();
        for (const turn of turns) {
          if (turn.role === 'tool' && turn.tool === 'read_file' && turn.detail) knownFiles.add(String(turn.detail));
        }
        break;
      }
      case 'cleared':
        stream = null;
        phase = '';
        earlierUserTurns = 0;
        knownFiles.clear();
        runningTools.clear();
        break;
    }
  });
})();
