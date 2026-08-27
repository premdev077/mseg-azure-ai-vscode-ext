import * as vscode from 'vscode';
import {
  EntryKind,
  SessionRecord,
  SessionRecorder,
  renderMarkdown
} from './history';

/**
 * The session report: what was asked, what changed, what actually ran and what
 * is still outstanding. Kept as a separate panel rather than folded into the
 * chat so it can be read while the conversation carries on, and exported as
 * Markdown for a handover.
 */
export class ReportPanel {
  private static current: ReportPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly recorder: SessionRecorder
  ) {
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.recorder.onDidChange(() => this.refresh()),
      this.panel.webview.onDidReceiveMessage(async (msg: any) => {
        if (msg?.type === 'ready') {
          this.refresh();
        } else if (msg?.type === 'export') {
          await exportReport(this.recorder.current);
        } else if (msg?.type === 'openFolder') {
          await vscode.commands.executeCommand('azureAiChat.openHistoryFolder');
        }
      })
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(ctx: vscode.ExtensionContext, recorder: SessionRecorder): void {
    if (ReportPanel.current) {
      ReportPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      ReportPanel.current.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureAiChat.report',
      'Session Report',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ReportPanel.current = new ReportPanel(panel, recorder);
    ctx.subscriptions.push({
      dispose: () => ReportPanel.current?.dispose()
    });
  }

  private refresh(): void {
    void this.panel.webview.postMessage({
      type: 'report',
      record: this.recorder.current
    });
  }

  private dispose(): void {
    if (ReportPanel.current === this) {
      ReportPanel.current = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 20px 24px; line-height: 1.55; }
  header { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap;
           border-bottom:1px solid var(--vscode-panel-border); padding-bottom:12px; margin-bottom:18px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; }
  button { font-family: inherit; font-size: 12px; padding: 4px 10px; border-radius: 4px;
           border: 1px solid transparent; cursor: pointer;
           color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing:.06em;
       color: var(--vscode-descriptionForeground); margin: 22px 0 8px; font-weight: 600; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 5px; }
  code { font-family: var(--vscode-editor-font-family); font-size: .92em;
         background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15));
         padding: 1px 5px; border-radius: 3px; }
  .task { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.08));
          border-left: 3px solid var(--vscode-textLink-foreground);
          padding: 10px 14px; border-radius: 0 4px 4px 0; }
  .cmd { display:flex; align-items:baseline; gap:8px; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; flex:none;
           border: 1px solid var(--vscode-panel-border); }
  .ok { color: var(--vscode-charts-green, #89d185); border-color: currentColor; }
  .bad { color: var(--vscode-charts-red, #f14c4c); border-color: currentColor; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 30px 0; }
  .counts { display:flex; gap:18px; flex-wrap:wrap; margin-bottom:4px; }
  .count b { font-size: 18px; font-weight: 600; display:block; line-height:1.2; }
  .count span { font-size: 10px; text-transform:uppercase; letter-spacing:.05em;
                color: var(--vscode-descriptionForeground); }
</style></head>
<body>
  <header>
    <div>
      <h1 id="title">Session Report</h1>
      <div class="meta" id="meta"></div>
    </div>
    <span class="spacer"></span>
    <button id="export">Export Markdown</button>
    <button id="folder" class="secondary">Open history folder</button>
  </header>
  <div id="body"><div class="empty">Nothing recorded yet.</div></div>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const bodyEl = document.getElementById('body');

  function el(tag, cls, text){ const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }

  function section(title, items, render){
    if(!items.length) return null;
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h2', null, title));
    const ul = el('ul');
    items.forEach(e => ul.appendChild(render(e)));
    frag.appendChild(ul);
    return frag;
  }

  function plain(e){ return el('li', null, e.text); }

  function render(record){
    document.getElementById('title').textContent = 'Session Report — ' + record.workspace;
    document.getElementById('meta').textContent =
      'started ' + new Date(record.startedAt).toLocaleString() +
      '  ·  updated ' + new Date(record.updatedAt).toLocaleTimeString() +
      '  ·  ' + record.entries.length + ' entries';

    bodyEl.textContent = '';
    if (!record.task && record.entries.length === 0) {
      bodyEl.appendChild(el('div','empty','Nothing recorded yet. Ask the assistant to do some work and this fills in as it goes.'));
      return;
    }

    const by = k => record.entries.filter(e => e.kind === k);
    const commands = by('command');
    const files = by('file-changed');
    const validation = by('validation');
    const todos = by('todo');

    const counts = el('div','counts');
    [['Files changed', files.length], ['Commands run', commands.length],
     ['Checks', validation.length], ['Outstanding', todos.length]].forEach(([label, n]) => {
      const c = el('div','count'); c.appendChild(el('b', null, String(n))); c.appendChild(el('span', null, label)); counts.appendChild(c);
    });
    bodyEl.appendChild(counts);

    if (record.task) {
      bodyEl.appendChild(el('h2', null, 'Task'));
      bodyEl.appendChild(el('div','task', record.task));
    }

    const add = f => { if (f) bodyEl.appendChild(f); };
    add(section('Requirements', by('requirement'), plain));
    add(section('Technical decisions', by('decision'), plain));
    add(section('Files changed', files, e => { const li=el('li'); li.appendChild(el('code',null,e.text)); return li; }));
    add(section('Bugs found', by('bug'), plain));
    add(section('Fixes applied', by('fix'), plain));
    add(section('Commands run', commands, e => {
      const li = el('li'); const row = el('div','cmd');
      row.appendChild(el('code', null, e.text));
      const okish = e.exitCode === 0;
      row.appendChild(el('span','badge ' + (okish ? 'ok' : 'bad'),
        e.exitCode === null || e.exitCode === undefined ? 'no exit' : 'exit ' + e.exitCode));
      li.appendChild(row); return li;
    }));
    add(section('Validation', validation, e => {
      const li = el('li');
      const failed = /FAILED/.test(e.text);
      li.appendChild(el('span', 'badge ' + (failed ? 'bad' : 'ok'), failed ? 'failed' : 'passed'));
      li.appendChild(document.createTextNode(' ' + e.text.replace(/: (passed|FAILED)$/,'')));
      return li;
    }));
    add(section('Outstanding', todos, plain));
    add(section('Notes', by('note'), plain));
  }

  document.getElementById('export').addEventListener('click', () => vscode.postMessage({type:'export'}));
  document.getElementById('folder').addEventListener('click', () => vscode.postMessage({type:'openFolder'}));
  window.addEventListener('message', e => { if (e.data && e.data.type === 'report') render(e.data.record); });
  vscode.postMessage({type:'ready'});
})();
</script></body></html>`;
  }
}

export async function exportReport(record: SessionRecord): Promise<void> {
  const suggested = `session-report-${record.workspace.replace(/[^A-Za-z0-9_-]/g, '-')}-${record.id.slice(0, 10)}.md`;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const target = await vscode.window.showSaveDialog({
    title: 'Export session report',
    defaultUri: folder
      ? vscode.Uri.joinPath(folder.uri, suggested)
      : vscode.Uri.file(suggested),
    filters: { Markdown: ['md'] }
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(
    target,
    new TextEncoder().encode(renderMarkdown(record))
  );
  const open = 'Open';
  const choice = await vscode.window.showInformationMessage(
    `Session report written to ${vscode.workspace.asRelativePath(target, false)}.`,
    open
  );
  if (choice === open) {
    await vscode.window.showTextDocument(target);
  }
}

export const REPORT_KINDS: EntryKind[] = [
  'requirement',
  'decision',
  'file-changed',
  'bug',
  'fix',
  'todo',
  'note',
  'command',
  'validation'
];
