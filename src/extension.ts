import * as vscode from 'vscode';
import { ChatViewProvider } from './panel';
import { EditReviewManager, PROPOSED_SCHEME } from './editReview';
import {
  chatCompletionsUrl,
  getApiKey,
  getSettings,
  isConfigured,
  moveInlineKeyToSecretStorage,
  offerToSecureInlineKey,
  promptForApiKey,
  SECRET_KEY
} from './config';
import { buildAuthHeaders } from './azureClient';
import { registerLanguageModelProvider } from './lmProvider';
import { CommandApprovalManager } from './commandApproval';
import {
  SessionRecorder,
  historyDir,
  listSessions,
  summariseForResume
} from './history';
import { ReportPanel, exportReport } from './report';
import { registerLanguageModelTools } from './lmTools';
import { ConversationStore } from './conversations';
import { clearCapabilityCache } from './azureClient';
import { AzureProvider } from './ai/azureProvider';

export function activate(context: vscode.ExtensionContext): void {
  const edits = new EditReviewManager();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, edits),
    edits
  );

  const commands = new CommandApprovalManager();
  const recorder = new SessionRecorder();
  context.subscriptions.push(commands, recorder);

  const store = new ConversationStore(context);

  // The agent loop talks to this, not to azureClient, so another provider can
  // be added without touching the loop, the tools or the UI.
  const model = new AzureProvider(getSettings, () => getApiKey(context));

  const provider = new ChatViewProvider(
    context,
    edits,
    commands,
    recorder,
    store,
    model
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Puts the configured deployments in VS Code's own Chat view model picker.
  // Absent on VS Code older than 1.104, in which case the sidebar still works.
  const lmRegistration = registerLanguageModelProvider(context);
  if (lmRegistration) {
    context.subscriptions.push(lmRegistration);
  }

  // The same shell / git / validation tools, offered to VS Code's own agent
  // mode so the native Chat view can drive them too.
  context.subscriptions.push(...registerLanguageModelTools(recorder));

  context.subscriptions.push(
    vscode.commands.registerCommand('azureAiChat.setApiKey', async () => {
      await promptForApiKey(context);
      provider.refreshStatus();
    }),

    vscode.commands.registerCommand('azureAiChat.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      provider.refreshStatus();
      vscode.window.showInformationMessage('Azure AI Chat: API key cleared.');
    }),

    vscode.commands.registerCommand('azureAiChat.secureApiKey', async () => {
      await moveInlineKeyToSecretStorage(context);
      provider.refreshStatus();
    }),

    vscode.commands.registerCommand('azureAiChat.newChat', () => provider.newChat()),

    vscode.commands.registerCommand('azureAiChat.focus', async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }),

    vscode.commands.registerCommand('azureAiChat.openChatView', async () => {
      await openNativeChatView();
    }),

    vscode.commands.registerCommand('azureAiChat.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'azureAiChat'
      );
    }),

    vscode.commands.registerCommand('azureAiChat.explainSelection', async () => {
      await provider.ask('Explain the selected code. Be concise.');
    }),

    vscode.commands.registerCommand('azureAiChat.editSelection', async () => {
      const instruction = await vscode.window.showInputBox({
        title: 'Edit with Azure AI Chat',
        prompt: 'What should change about the selected code?',
        placeHolder: 'e.g. add error handling and JSDoc',
        ignoreFocusOut: true
      });
      if (!instruction) {
        return;
      }
      await provider.ask(
        `${instruction}\n\nApply this to the selected code in the active file. Read the file first, then propose the edit with write_file.`
      );
    }),

    vscode.commands.registerCommand('azureAiChat.testConnection', async () => {
      await testConnection(context);
    }),

    vscode.commands.registerCommand('azureAiChat.showHistory', async () => {
      await provider.showHistory();
    }),

    vscode.commands.registerCommand('azureAiChat.clearHistory', async () => {
      const items = await store.list();
      if (items.length === 0) {
        vscode.window.showInformationMessage(
          'Azure AI Chat: there are no saved conversations.'
        );
        return;
      }
      const yes = 'Delete all';
      const choice = await vscode.window.showWarningMessage(
        `Delete all ${items.length} saved conversation(s)? This cannot be undone.`,
        { modal: true },
        yes
      );
      if (choice === yes) {
        const n = await store.deleteAll();
        vscode.window.showInformationMessage(
          `Azure AI Chat: deleted ${n} conversation(s).`
        );
        await provider.showHistory();
      }
    }),

    vscode.commands.registerCommand('azureAiChat.openConversationsFolder', async () => {
      try {
        await vscode.workspace.fs.createDirectory(store.folder);
      } catch {
        /* already there */
      }
      await vscode.env.openExternal(store.folder);
    }),

    vscode.commands.registerCommand('azureAiChat.showReport', () => {
      ReportPanel.show(context, recorder);
    }),

    vscode.commands.registerCommand('azureAiChat.exportReport', async () => {
      recorder.flushNow();
      await exportReport(recorder.current);
    }),

    vscode.commands.registerCommand('azureAiChat.attachFiles', async () => {
      await provider.pickAttachments();
    }),

    vscode.commands.registerCommand('azureAiChat.openHistoryFolder', async () => {
      const dir = vscode.Uri.file(historyDir());
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        /* already there */
      }
      await vscode.env.openExternal(dir);
    }),

    vscode.commands.registerCommand('azureAiChat.resumeSession', async () => {
      await resumeSession(provider);
    }),

    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('azureAiChat')) {
        provider.refreshStatus();
        void offerToSecureInlineKey(context);
      }
      if (e.affectsConfiguration('azureAiChat.connection')) {
        // A different endpoint or deployment may have different capabilities.
        clearCapabilityCache();
      }
    })
  );

  // A key sitting in settings.json is worth flagging once, quietly.
  void offerToSecureInlineKey(context);
}

/**
 * Opens VS Code's built-in Chat view. The command id has moved between
 * releases, so try the known ones and tell the user plainly if none exist.
 */
async function openNativeChatView(): Promise<void> {
  const candidates = [
    'workbench.action.chat.open',
    'workbench.action.chat.openInSidebar',
    'workbench.panel.chat.view.copilot.focus',
    'workbench.action.chat.newChat'
  ];
  const available = await vscode.commands.getCommands(true);
  for (const id of candidates) {
    if (available.includes(id)) {
      await vscode.commands.executeCommand(id);
      return;
    }
  }
  vscode.window.showWarningMessage(
    'Azure AI Chat: this VS Code build has no built-in Chat view. Use the Azure AI Chat sidebar instead, or update VS Code to 1.122 or later.'
  );
}

async function testConnection(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  if (!isConfigured(settings)) {
    const open = 'Open Settings';
    const choice = await vscode.window.showErrorMessage(
      'Azure AI Chat: set "azureAiChat.connection" → endpoint and model first.',
      open
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'azureAiChat.connection'
      );
    }
    return;
  }

  let key = await getApiKey(context, settings);
  if (!key) {
    key = await promptForApiKey(context);
  }
  if (!key) {
    vscode.window.showErrorMessage('Azure AI Chat: no API key set.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Azure AI Chat: testing connection…'
    },
    async () => {
      const results: string[] = [];

      for (const model of settings.models) {
        let url: string;
        try {
          url = chatCompletionsUrl(settings, model);
        } catch (e) {
          results.push(`${model}: ${(e as Error).message}`);
          continue;
        }

        const body: Record<string, unknown> = {
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          stream: false
        };
        if (settings.apiMode === 'v1') {
          body.model = model;
        }
        if (settings.useMaxCompletionTokens) {
          body.max_completion_tokens = 16;
        } else {
          body.max_tokens = 16;
        }

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: buildAuthHeaders(settings, key!),
            body: JSON.stringify(body)
          });
          const text = await res.text();
          results.push(
            res.ok
              ? `${model}: OK (HTTP ${res.status})`
              : `${model}: HTTP ${res.status} — ${text.slice(0, 300)}`
          );
        } catch (e) {
          results.push(`${model}: unreachable — ${(e as Error).message}`);
        }
      }

      const allOk = results.every((r) => r.includes(': OK ('));
      const summary = results.join('\n');
      if (allOk) {
        vscode.window.showInformationMessage(`Azure AI Chat: connected.\n${summary}`);
      } else {
        vscode.window.showErrorMessage(`Azure AI Chat:\n${summary}`);
      }
    }
  );
}

/**
 * Loads a previous session's summary into the chat as context. The summary is
 * explicitly framed as recovered context, not fact — the current code always
 * wins over what a past session believed.
 */
async function resumeSession(provider: ChatViewProvider): Promise<void> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    vscode.window.showInformationMessage(
      'Azure AI Chat: no previous sessions were found in the local history folder.'
    );
    return;
  }

  const items = sessions.map((record) => ({
    label: record.task ? record.task.slice(0, 70) : '(no task recorded)',
    description: record.workspace,
    detail: `${new Date(record.updatedAt).toLocaleString()} · ${record.entries.length} entries`,
    record
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Resume a previous session',
    placeHolder: 'Pick the session whose context you want to load'
  });
  if (!picked) {
    return;
  }

  await provider.ask(
    `${summariseForResume(picked.record)}\n\nSummarise where this work stopped and what you would do next. Verify the important claims against the current code before you rely on them.`
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}
