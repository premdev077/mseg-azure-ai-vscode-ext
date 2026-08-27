# Azure AI Chat

An agentic coding assistant for VS Code that runs entirely against **your own Azure OpenAI deployment**. Nothing goes anywhere else: the extension calls your endpoint directly, and there are no runtime dependencies.

It works in two places:

- **Its own sidebar** — a chat panel with a full agent loop, attachments, a model picker, thinking control, Git Bash execution and a session report.
- **VS Code's native Chat view** — your Azure deployments appear in the model picker, and this extension's shell / git / validation tools are available to agent mode.

---

## 1. Install

```
code --install-extension azure-ai-chat-0.4.0.vsix
```

Or `Ctrl+Shift+P` → **Extensions: Install from VSIX…**

To build from source: `npm install && npm run package && npm run vsix`. To develop it, open the folder and press `F5`.

**Requires VS Code 1.104 or later.** The native Chat view additionally needs **1.122+**, which is the release that made the Chat view work without a GitHub sign-in.

## 2. Configure

One settings object holds the connection:

```json
"azureAiChat.connection": {
  "endpoint": "https://my-resource.openai.azure.com",
  "model": "gpt-4o",
  "apiKey": ""
}
```

- **`endpoint`** — your resource endpoint. No path, no trailing slash.
- **`model`** — the **deployment name** from Azure AI Foundry, not the underlying model name. It can also be a list, and every entry appears in both model pickers:
  ```json
  "model": ["gpt-4o", "gpt-4o-mini", "o3-mini"]
  ```
- **`apiKey`** — optional. See below.
- **`apiMode`** — `v1` (default) or `classic`. Switch to `classic` if you get a 404.
- **`apiVersion`** — used only in `classic` mode.

### Where the API key lives

You can put the key straight into the settings object, and it will be used. But `settings.json` is plain text: it travels with Settings Sync, and it gets committed to git if it lives in a workspace `.vscode` folder. The extension will notice a key there and offer to move it, once.

The safer route is to leave `apiKey` empty and run **Azure AI Chat: Set API Key**, which stores it in VS Code's encrypted SecretStorage. **Azure AI Chat: Move API Key to Secret Storage** migrates one that is already in settings.

Then run **Azure AI Chat: Test Connection** — it makes one small call per configured deployment and reports the exact HTTP status, which is far easier to debug than a failed chat.

## 3. The chat area

| Control | What it does |
|---|---|
| **Attach** | Multi-select files for the model to read (see below) |
| **Model** | Which of your configured deployments this message goes to |
| **Thinking** | `reasoning_effort` — minimal / low / medium / high |
| **Active file** | Attaches the current editor file and selection |

The view header holds **＋** (new chat), **history**, **session report** and **settings**.

Enter sends, Shift+Enter adds a newline.

**Thinking** only applies to reasoning deployments (o-series, GPT-5 family). Setting it also switches the request to `max_completion_tokens` and drops `temperature`, because those models reject both — so you do not have to flip a separate setting. When a deployment streams a reasoning summary, it appears in a collapsible block above the answer.

Some deployments refuse a thinking level and function tools in the *same* `/chat/completions` request — gpt-5.x does this, and returns a 400 saying to use `/v1/responses` or set `reasoning_effort` to `none`. There is no capability endpoint that reports it in advance, so the extension learns it from the error: the request is retried immediately without the thinking level, you get a one-line notice, and the rest of the session skips the level for that deployment. Tools are worth more than a thinking level here. **Thinking: none** sends `reasoning_effort: "none"` explicitly, which is what some deployments require before they will accept tools at all.

### Attachments

Attach several files at once. Text is extracted locally, with no dependency and nothing sent anywhere but your own endpoint.

| Type | Handling |
|---|---|
| `.png` `.jpg` `.jpeg` `.gif` `.webp` | Sent as images to a vision-capable deployment (8 MB limit) |
| `.pdf` | Text extracted, including PDFs with embedded/subset fonts. A scan with no text layer is reported as such rather than sent as silence |
| `.docx` | Body, headers, footers and footnotes |
| `.pptx` | Slide text and speaker notes |
| `.xlsx` | Each sheet as TSV |
| `.txt` `.md` `.json` `.html` `.csv` `.xml` `.yaml` and source files | Read as text with a language-tagged fence |

Large files are truncated to `azureAiChat.maxFileBytes`. Legacy binary Office formats (`.doc`, `.ppt`, `.xls`) are not readable — save as the modern format. `.bmp`, `.tiff` and `.svg` are not accepted by the vision API; convert to PNG.

## 4. What the assistant can do

**Read and search** the workspace — `read_file`, `list_files`, `search_workspace`, `get_diagnostics`.

**Edit files** — every edit is a diff you Apply or Discard, and the model is told which you chose. Nothing is written until you click. `azureAiChat.autoApproveEdits` turns the gate off; it is off by default for a reason.

**Run commands** through Git Bash, under a policy:

- **Runs immediately**: read-only commands (`ls`, `grep`, `find`, `cat`, `git status`, `git diff`, `git log`, version checks) and the project's own check scripts (`npm test`, `npm run build`, `npm run type-check`, `pytest`, `tsc --noEmit`, `eslint`).
- **Asks first**: anything that changes files, packages, the repository or the machine — `rm`, `mv`, `git commit`, `git reset`, `git clean`, `npm install`, `pip install`, output redirection, `curl`, arbitrary scripts, and any command it does not recognise.
- **Refused outright**: `rm -rf /`, `mkfs`, `dd` to a device, `shutdown`, force-pushing a protected branch, fork bombs.

A command line is split on `&&`, `||`, `;` and `|` with quotes respected, and every segment is classified — so `git status && rm -rf dist` asks before running. `azureAiChat.shell.requireApprovalForAll` makes everything ask.

stdin is closed, so anything that tries to prompt gets EOF instead of hanging. Commands time out (120 s by default), output is capped, and the whole process tree is killed on timeout or cancel.

**Validate its work** — `run_validation` reads `package.json` / `pyproject.toml` / `tsconfig.json` and runs the project's real scripts, returning real exit codes. The system prompt forbids claiming a check passed that was not run.

**Record context** — the assistant logs the requirement, decisions, files changed, bugs, fixes and outstanding items as it works.

## 5. History

The **history** icon in the view header lists your past conversations — newest first, with the message count, workspace and model. Click one and it reloads into the panel and **continues**: the assistant still has the full transcript, so you can pick up mid-thread. Continuing an old conversation floats it back to the top. Hover a row for the **×** to delete it.

Transcripts are stored **on the machine VS Code is running on**, in VS Code's own per-user extension storage:

```
%APPDATA%\Code\User\globalStorage\minterellison.azure-ai-chat\conversations\
```

That is deliberately not the temp folder — a conversation you can reopen should not vanish when Windows cleans `%TEMP%`. **Azure AI Chat: Open Conversations Folder** opens it; **Delete All Saved Conversations** clears it; `azureAiChat.saveConversations: false` turns it off.

Transcripts are stored verbatim, because redacting them would corrupt the content a continuation depends on. What *is* stripped is image data — a base64 image would put megabytes on disk per turn, so it is replaced with a note saying the image is not part of the reloaded history.

## 6. Session report

**Azure AI Chat: Show Session Report** (also in the header) opens a panel with the task, files changed, commands run with exit codes, validation results and outstanding items. Export it as Markdown for a handover.

The report — unlike the transcript — is a *summary*, so it is also written to `%LOCALAPPDATA%\Temp\merw-azure-ai\conversations\`, and **secrets are redacted before anything is written**: `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=` assignments, bearer tokens, JWTs, long hex keys, connection-string account keys, credentials embedded in URLs and private-key blocks all become `<REDACTED>`. **Resume a Previous Session** loads one back as context — framed explicitly as recovered context, not fact, since the current code is always the source of truth. Turn it off with `azureAiChat.saveSessionHistory: false`.

## 7. Native Chat view

Once configured, your deployments appear in VS Code's own Chat model picker under **Azure OpenAI (your deployment)**. VS Code owns the conversation, the tools and the edit review; this extension supplies the model and translates between VS Code's message parts and Azure's REST shape, including tool calling.

It also contributes five tools that agent mode can use, referenceable with `#azureRun`, `#azureGitStatus`, `#azureGitDiff`, `#azureValidate` and `#azureRecord`. They apply the same command policy — read-only commands run, mutating ones raise VS Code's confirmation prompt.

**Azure AI Chat: Open in Chat View** jumps there.

---

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| `connection` | `{}` | endpoint, model, apiKey, apiMode, apiVersion |
| `reasoningEffort` | `""` | Default thinking level (`none`/`minimal`/`low`/`medium`/`high`); the composer overrides per message |
| `temperature` | `0.2` | Ignored by reasoning models |
| `maxTokens` | `8000` | Per response |
| `useMaxCompletionTokens` | `false` | Force the reasoning-model request shape |
| `maxToolIterations` | `12` | Tool round-trips before the loop stops |
| `autoApproveEdits` | `false` | Skip the diff review |
| `includeActiveFile` | `true` | Master switch for the composer toggle |
| `maxFileBytes` | `200000` | Truncation limit for files and attachments |
| `excludeGlobs` | node_modules, .git, dist… | Skipped by listing and search |
| `systemPrompt` | `""` | Appended to the built-in engineering prompt |
| `shell.bashPath` | `""` | Explicit `bash.exe`; empty auto-detects |
| `shell.requireApprovalForAll` | `false` | Ask before every command |
| `shell.timeoutSeconds` | `120` | Default command timeout, max 600 |
| `saveSessionHistory` | `true` | Write the session *report* to the temp folder |
| `saveConversations` | `true` | Save transcripts so History can reopen them |

## Commands

| Command | Keybinding |
|---|---|
| Focus Chat | `Ctrl+Alt+I` |
| Edit Selection with AI | `Ctrl+Alt+K` |
| Set / Clear / Move API Key | — |
| Test Connection | — |
| Show / Export Session Report | — |
| Show History | — |
| Delete All Saved Conversations | — |
| Open Conversations Folder | — |
| Resume a Previous Session | — |
| Attach Files | — |
| Open in Chat View | — |
| Open Session History Folder | — |

---

## Troubleshooting

**401** — the key was rejected. Run *Set API Key* again.

**404** — the deployment name does not match, or your resource does not serve the v1 surface. Check the name in Azure AI Foundry → Deployments, then try `apiMode: "classic"`.

**400 mentioning `max_tokens` or `temperature`** — a reasoning deployment. Set a Thinking level, or turn on `useMaxCompletionTokens`.

**400 saying function tools are not supported with `reasoning_effort`** — handled automatically; you will see a notice and the answer continues. To silence it, set Thinking to `none` or `default` for that deployment.

**429** — the deployment's TPM quota is exhausted.

**"Git Bash was not found"** — install Git for Windows, or set `azureAiChat.shell.bashPath` to your `bash.exe`.

**A command timed out with no output** — it was probably interactive or a watcher. stdin is closed here; ask for a non-interactive form (`npm test -- --watchAll=false`).

**Connection times out behind a proxy** — VS Code's `http.proxy` / `http.proxySupport` apply to the extension host. *Test Connection* shows the underlying error.

**Azure models not in the native Chat picker** — needs VS Code 1.122+. Run *Test Connection* first; the provider only offers models once the endpoint, deployment and key all resolve.

## Architecture

```
src/
  extension.ts        activation, commands, connection test
  panel.ts            sidebar webview host ⇄ webview messaging
  chatSession.ts      conversation state and the tool-calling agent loop
  azureClient.ts      Azure SSE streaming, multimodal content, reasoning effort
  tools.ts            tool schemas and implementations
  editReview.ts       virtual documents + accept/reject for proposed edits
  commandApproval.ts  the same gate for commands
  attachments.ts      file ingestion and content-part construction
  prompt.ts           the built-in engineering prompt
  history.ts          session report recording, redaction, resume
  conversations.ts    transcript persistence in VS Code global storage
  report.ts           the session report panel
  lmProvider.ts       Azure as a model in the native Chat view
  lmTools.ts          the tools, contributed to agent mode
  shell/
    policy.ts         command classification (auto / approve / denied)
    exec.ts           Git Bash discovery and sandboxed execution
  extract/
    pdf.ts            PDF parser: object streams, page tree, ToUnicode CMaps
    ooxml.ts          docx / pptx / xlsx text extraction
    zip.ts            minimal ZIP reader
media/
  main.js, main.css   webview UI
```

The webview runs under a strict CSP with a per-load nonce, and every piece of model or file content is rendered with `textContent` rather than `innerHTML` — nothing from a model or a document can execute as HTML in the panel.

## Extending it

**Add a tool**: add a spec to `TOOL_SPECS` in `src/tools.ts` and a case in `runTool`. To expose it to native agent mode as well, add an entry to `contributes.languageModelTools` and a class in `src/lmTools.ts`.

**Adjust the command policy**: the lists in `src/shell/policy.ts` are the whole policy — `READ_ONLY`, `GIT_READ_ONLY`, `VALIDATION`, `SAFE_SCRIPTS` and `CATASTROPHIC`.

**Change the prompt**: `buildSystemPrompt` in `src/prompt.ts`. For per-user tweaks, `azureAiChat.systemPrompt` is appended rather than replacing it.

**Switch to Entra ID auth**: `buildAuthHeaders` in `src/azureClient.ts` is the only place the key becomes headers. Swap it for a token from `@azure/identity` or the VS Code Microsoft auth provider.

## Licence

MIT.
