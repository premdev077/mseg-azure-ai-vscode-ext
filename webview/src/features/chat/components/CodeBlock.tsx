import { Check, Copy, CornerUpLeft } from 'lucide-react';
import { memo, useState } from 'react';
import { IconButton } from '../../../components/ui/IconButton';

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  onCopy,
  onInsert
}: {
  code: string;
  lang?: string | undefined;
  onCopy: (code: string) => void;
  onInsert: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="overflow-hidden rounded-sm border border-line bg-sunken">
      <div className="flex min-h-6 items-center gap-1 border-b border-line pr-1 pl-2">
        <span className="font-mono text-2xs text-muted">{lang ?? 'text'}</span>
        <span className="flex-1" />
        <IconButton
          icon={
            copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />
          }
          label={copied ? 'Copied' : 'Copy code'}
          onClick={() => {
            onCopy(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        />
        <IconButton
          icon={<CornerUpLeft size={12} aria-hidden />}
          label="Insert at cursor"
          onClick={() => onInsert(code)}
        />
      </div>
      <pre className="m-0 overflow-x-auto p-2 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
});
