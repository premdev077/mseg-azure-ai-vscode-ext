# Azure AI Chat

An agentic coding assistant for VS Code that runs entirely against **your own Azure OpenAI deployment**. Nothing goes anywhere else: the extension calls your endpoint directly, and there are no runtime dependencies.

It works in two places:

- **Its own sidebar** — a chat panel with a full agent loop, attachments, a model picker, thinking control, Git Bash execution and a session report.
- **VS Code's native Chat view** — your Azure deployments appear in the model picker, and this extension's shell / git / validation tools are available to agent mode.

---

## 1. Install

### From a `.vsix`

```
code --install-extension mseg-azure-ai-vscode-ext-1.0.0.vsix
```

Or `Ctrl+Shift+P` → **Extensions: Install from VSIX…** and pick the file.

Then reload the window (`Ctrl+Shift+P` → **Developer: Reload Window**) and open the
**Azure AI Chat** icon in the activity bar.

To remove it: `code --uninstall-extension Premraj.mseg-azure-ai-vscode-ext`.

### Building the `.vsix` yourself

The extension is **two bundles** — the extension host and the webview UI — and both
must be built before packaging. `npm run vsix` does not build; it packages whatever
is on disk, so a stale or missing webview build ships a blank panel.

```bash
npm install          # once
npm run package      # builds BOTH: esbuild → dist/, vite → media/webview/
npm run vsix         # writes ./mseg-azure-ai-vscode-ext-<version>.vsix
```

`npm run vsix` alone is only safe immediately after `npm run package`.

Check what is about to ship before you hand the file to anyone:

```bash
npx @vscode/vsce ls --no-dependencies
```

You should see exactly these, and nothing else:

```
LICENSE
README.md
package.json
dist/extension.js          the extension host, bundled
media/icon.svg
media/webview/app.js       the React UI, bundled
media/webview/app.css
media/webview/index.html
```

If `media/webview/*` is missing you skipped `npm run package`; installing that VSIX
gives an empty sidebar. If anything else appears — `.env`, `.husky/`, source files —
`.vscodeignore` has drifted and should be fixed before publishing.

### Running from source

```bash
npm install
npm run watch          # extension host, rebuilds on change
npm run watch:webview  # webview, in a second terminal
```

Then press **F5** to launch an Extension Development Host. After changing webview
code, reload that window to pick up the new bundle.

To work on the UI without an Azure key at all:

```bash
npm run preview        # http://localhost:5599/preview.html
```

That renders the real panel against a seeded multi-agent run. Add
`?scenario=live` to watch a run stream in event by event, `?scenario=verified`
for a finished one, or `?scenario=empty` for the first-launch state. The preview
is developer tooling and is not part of the packaged extension.

**Requires VS Code 1.104 or later.** The native Chat view additionally needs **1.122+**,
which is the release that made the Chat view work without a GitHub sign-in.

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

## Multi-agent runs

Off by default. A turn runs the way it always has until you opt in:

```json
"azureAiChat.orchestration": "multi-agent"
```

| Value | What a turn does |
|---|---|
| `single` | The original loop. One agent, one conversation. **Default.** |
| `coordinated` | The same single agent, but through the Coordinator, so task state, file locks and the token budget apply. |
| `multi-agent` | The full pipeline below. |

### What a multi-agent turn does

```
git baseline captured
        ↓
five read-only planners, in parallel
        ↓
plans aggregated; disagreements surfaced, not silently resolved
        ↓
scoped coders — each may edit only its assigned files
        ↓
an independent Verification Agent re-inspects the repository
        ↓
   passed ──→ COMPLETED        failed ──→ repair, then verify again (max 3)
```

Two rules this enforces that the single-agent loop cannot:

- **A coding agent cannot declare success.** Only the verifier moves a run to
  completed, and it re-runs the project's real checks rather than trusting what
  the coders reported. A skipped check is reported as skipped, never as passed.
- **Your uncommitted work is protected.** The baseline taken before the run is
  what lets the verifier tell an agent's edit from yours, and flag any file that
  changed but no task claimed.

### Give each role its own deployment

Planners are cheap and numerous; the verifier is the last line of defence. Pointing
them at different deployments is what makes that affordable:

```json
"azureAiChat.connection": { "model": ["sol", "luna", "terra"] },
"azureAiChat.modelRoles": {
  "coordinator": "sol",
  "planner":     "luna",
  "coder":       "sol",
  "verifier":    "terra",
  "repair":      "sol"
}
```

Every name must also appear in `connection.model`. One that does not is reported
once and ignored rather than failing mid-run. A role left empty uses the first
deployment in the list.

**Several roles on one deployment share its TPM quota**, and parallel agents will
throttle each other. If you only have one deployment, lower `concurrency` rather
than hoping.

### Cost

A multi-agent turn costs several times a single one. Five planners run before any
code is written, so the ceilings matter:

```json
"azureAiChat.budget": {
  "maxTotalTokens": 500000,
  "maxAgents": 20,
  "totalTaskTimeoutMs": 900000,
  "agentTimeoutMs": 300000
},
"azureAiChat.concurrency": {
  "maxConcurrentAgents": 5,
  "maxPlanningAgents": 5,
  "maxCodingAgents": 4,
  "maxRepairAgents": 3
}
```

Reaching a limit stops **new** agents starting; work already in flight finishes and
the run reports that it was cut short. Tokens are the limit that bites first —
agent mode's prompt alone is roughly 12k tokens, so a handful of wide agents costs
more than a long run of narrow ones.

### Depth, per message

Separately from orchestration, the composer's **Mode** selector sets how much
investigation a turn does:

| Mode | Tools | Prompt | For |
|---|---|---|---|
| Fast | read-only | ~2k tokens | Explaining code, finding a symbol, a small snippet |
| Thinking | all | ~5k tokens | A change that deserves inspecting and verifying |
| Agent | all | ~11k tokens | Finish it, including running checks and fixing failures |

`azureAiChat.mode` sets the default; the composer overrides it per message.

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
| `mode` | `agent` | Default depth when the composer selector is untouched: `fast` / `thinking` / `agent` |
| `modelRoles` | `{}` | Which deployment serves each agent role — see [Multi-agent runs](#multi-agent-runs) |
| `orchestration` | `single` | `single` / `coordinated` / `multi-agent` |
| `maxVerificationAttempts` | `3` | Verify → repair → verify rounds before a run is reported failed |
| `budget` | see below | Token, agent and time ceilings for one run |
| `concurrency` | see below | How many agents may run at once, globally and per role |
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

**The sidebar is blank after installing a `.vsix`** — the webview bundle is missing.
It is built by `npm run package`, not by `npm run vsix`. Rebuild and repackage, then
confirm with `npx @vscode/vsce ls --no-dependencies` that `media/webview/app.js` is
listed. Open **Developer: Open Webview Developer Tools** to see the load error.

**The panel does not pick up webview changes during `F5` development** — the
Extension Development Host caches the bundle. Run `npm run watch:webview`, then
reload that window. Reloading the *host* window is not enough on its own.

**"Multi-agent runs need an open folder"** — every agent works against the
workspace, so a window with no folder cannot run one. Open a folder, or set
`azureAiChat.orchestration` back to `single`.

**A multi-agent run stops early saying it reached a budget** — expected, and the
report says which ceiling. Raise `azureAiChat.budget`, or lower
`azureAiChat.concurrency` if the cause was throttling rather than spend.

**"X is set as the verifier model but is not one of the configured deployments"** —
a name in `modelRoles` is not in `connection.model`. The run continues on the
default deployment; fix the spelling to get the routing you asked for.

## Architecture

Two processes, one repository. They share the event contract and nothing else.

```
src/                        EXTENSION HOST — Node, bundled by esbuild → dist/
  extension.ts              activation, commands, connection test
  panel.ts                  webview host; validates every inbound message
  chatSession.ts            the single-agent loop
  azureClient.ts            Azure SSE streaming, multimodal, reasoning effort
  tools.ts / toolArgs.ts    tool schemas, and narrowing for model-written args
  patch/apply.ts            anchored search-and-replace editing
  editReview.ts             virtual documents + accept/reject for edits
  commandApproval.ts        the same gate for commands
  events/                   the event contract, bus, replay buffer
  agent/
    coordinator.ts          task state, locks, budget — the single authority
    taskGraph.ts            dependency graph and readiness
    scheduler.ts            bounded, priority-aware concurrency
    locks.ts                file ownership, so two agents cannot collide
    scope.ts                what an agent may modify
    planning/               five read-only planners, aggregation, conflicts
    implement/              scoped coders
    verify/                 the independent verifier and the repair loop
    run.ts                  plan → implement → verify → repair, in order
  git/baseline.ts           tells AI edits from your uncommitted work
  shell/policy.ts           command classification (auto / approve / denied)
  extract/                  PDF, OOXML and ZIP readers

webview/                    UI — React + TypeScript, bundled by Vite → media/webview/
  src/store/                one event pipeline, normalised domain slices
  src/services/             the message bridge; the only place transport lives
  src/features/             agents, chat, changes, commands, verification…
  src/components/           ui primitives, shared states, layout
```

The webview runs under a strict CSP with a per-load nonce. It holds no secrets and
makes no network calls of its own — the host owns the key and every privileged
operation. Messages are validated at both ends of the bridge, and model output is
escaped before rendering, so nothing from a model or a document can execute as HTML.

## Extending it

**Add a tool**: add a spec to `TOOL_SPECS` in `src/tools.ts` and a case in `runTool`. To expose it to native agent mode as well, add an entry to `contributes.languageModelTools` and a class in `src/lmTools.ts`.

**Adjust the command policy**: the lists in `src/shell/policy.ts` are the whole policy — `READ_ONLY`, `GIT_READ_ONLY`, `VALIDATION`, `SAFE_SCRIPTS` and `CATASTROPHIC`.

**Change the prompt**: `buildSystemPrompt` in `src/prompt.ts`. For per-user tweaks, `azureAiChat.systemPrompt` is appended rather than replacing it.

**Switch to Entra ID auth**: `buildAuthHeaders` in `src/azureClient.ts` is the only place the key becomes headers. Swap it for a token from `@azure/identity` or the VS Code Microsoft auth provider.

## Licence

MIT.
