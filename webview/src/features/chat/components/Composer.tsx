import { Paperclip, Send, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { IconButton } from '../../../components/ui/IconButton';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { SHORTCUTS } from '../../../constants/shortcuts';
import { useKeyboardShortcut } from '../../../hooks/useKeyboardShortcut';
import { PREFILL_EVENT, type PrefillDetail } from '../../../services/messageBridge';
import { host } from '../../../services/vscode';
import { useAppStore } from '../../../store/appStore';

const EFFORTS: readonly SelectOption[] = [
  { value: '', label: 'Thinking: default' },
  { value: 'none', label: 'Thinking: none' },
  { value: 'minimal', label: 'Thinking: minimal' },
  { value: 'low', label: 'Thinking: low' },
  { value: 'medium', label: 'Thinking: medium' },
  { value: 'high', label: 'Thinking: high' }
];

/** Context tokens the host understands, shown so they are discoverable. */
const CONTEXT_HINTS = '@file  @selection  @workspace  @git';

export function Composer() {
  const status = useAppStore((s) => s.status);
  const busy = useAppStore((s) => s.app.stream.busy);
  const attachments = useAppStore((s) => s.attachments);
  const addUserMessage = useAppStore((s) => s.addUserMessage);

  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [effort, setEffort] = useState('');
  const [attachContext, setAttachContext] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Adopt the host's defaults once, then leave the user's choice alone: a
  // status refresh mid-conversation must not silently reset their model.
  const touched = useRef({ model: false, mode: false, effort: false });
  useEffect(() => {
    if (!status) {
      return;
    }
    if (!touched.current.model && status.models.length > 0) {
      setModel((current) =>
        status.models.includes(current) ? current : (status.models[0] ?? '')
      );
    }
    if (!touched.current.mode && status.defaultMode) {
      setMode(status.defaultMode);
    }
    if (!touched.current.effort && status.defaultEffort) {
      setEffort(status.defaultEffort);
    }
  }, [status]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (busy || (trimmed.length === 0 && attachments.length === 0)) {
      return;
    }
    const payload =
      trimmed.length > 0 ? trimmed : 'Please review the attached file(s).';
    addUserMessage(payload);
    host.send({ text: payload, model, mode, reasoningEffort: effort, attachContext });
    setText('');
  }, [
    text,
    busy,
    attachments.length,
    addUserMessage,
    model,
    mode,
    effort,
    attachContext
  ]);

  useKeyboardShortcut(
    SHORTCUTS.focusComposer,
    useCallback(() => inputRef.current?.focus(), [])
  );
  useKeyboardShortcut(SHORTCUTS.stopRun, host.cancel, busy);

  // The host can pre-fill the composer, e.g. from "Explain Selection".
  useEffect(() => {
    const onPrefill = (event: Event): void => {
      const detail = (event as CustomEvent<PrefillDetail>).detail;
      setText(detail.text);
      inputRef.current?.focus();
    };
    window.addEventListener(PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(PREFILL_EVENT, onPrefill);
  }, []);

  const modeOptions: readonly SelectOption[] = (status?.modes ?? []).map((m) => ({
    value: m.mode,
    label: m.label,
    description: m.description
  }));
  const modelOptions: readonly SelectOption[] = (status?.models ?? []).map((m) => ({
    value: m,
    label: m
  }));

  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-canvas px-2 pt-1.5 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="Attachments">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className={`inline-flex max-w-full items-center gap-1 rounded-sm border bg-surface py-px pr-1 pl-1.5 text-2xs ${
                attachment.error !== undefined
                  ? 'border-danger text-danger'
                  : 'border-line'
              }`}
            >
              <span
                className="truncate"
                title={attachment.error ?? attachment.note ?? attachment.name}
              >
                {attachment.name}
              </span>
              <span className="text-muted">{attachment.size}</span>
              <IconButton
                icon={<X size={11} aria-hidden />}
                label={`Remove ${attachment.name}`}
                onClick={() => host.removeAttachment(attachment.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={inputRef}
        rows={3}
        value={text}
        aria-label="Message"
        placeholder="Ask AI to modify your code…  (Ctrl+K to focus)"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        className="min-h-13 w-full resize-y rounded-sm border border-line bg-field p-1.5 font-sans text-base leading-normal text-field-ink placeholder:text-placeholder"
      />

      <div className="flex flex-wrap items-center gap-1">
        <IconButton
          icon={<Paperclip size={13} aria-hidden />}
          label="Attach files"
          onClick={host.attach}
        />

        <Select
          label="Mode"
          title="How much investigation and verification this turn should do"
          value={mode}
          options={modeOptions}
          onChange={(value) => {
            touched.current.mode = true;
            setMode(value);
          }}
        />

        <Select
          label="Model"
          title="Which deployment to send this to"
          value={model}
          options={modelOptions}
          onChange={(value) => {
            touched.current.model = true;
            setModel(value);
          }}
        />

        <Select
          label="Thinking"
          title="Reasoning effort. Only reasoning deployments accept this."
          value={effort}
          options={EFFORTS}
          onChange={(value) => {
            touched.current.effort = true;
            setEffort(value);
          }}
        />

        <label className="inline-flex cursor-pointer items-center gap-1 text-xs whitespace-nowrap text-muted">
          <input
            type="checkbox"
            checked={attachContext}
            onChange={(event) => setAttachContext(event.target.checked)}
          />
          <span>Active file</span>
        </label>

        <span className="flex-1" />

        {busy ? (
          <Button variant="danger" onClick={host.cancel} title="Stop (Escape)">
            <Square size={11} aria-hidden /> Stop
          </Button>
        ) : (
          <Button variant="primary" type="submit" title="Send (Enter)">
            <Send size={11} aria-hidden /> Send
          </Button>
        )}
      </div>

      <div className="flex gap-2 text-2xs text-muted">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span className="flex-1" />
        <span className="hidden font-mono sm:inline">{CONTEXT_HINTS}</span>
      </div>
    </form>
  );
}
