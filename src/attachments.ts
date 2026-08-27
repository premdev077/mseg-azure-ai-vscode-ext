import * as vscode from 'vscode';
import * as path from 'path';
import { Settings } from './config';
import { extractPdf } from './extract/pdf';
import { extractDocx, extractPptx, extractXlsx } from './extract/ooxml';
import { ContentPart } from './azureClient';

export type AttachmentKind = 'text' | 'image' | 'document' | 'unsupported';

export interface Attachment {
  id: string;
  /** Absolute path on disk. */
  fsPath: string;
  /** Short label shown on the chip. */
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** Extracted text, for `text` and `document` kinds. */
  text?: string;
  /** data: URL, for `image`. */
  dataUrl?: string;
  mime?: string;
  /** Anything the user should know — truncation, a scanned PDF, and so on. */
  note?: string;
  error?: string;
}

/** Formats OpenAI's vision API accepts. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

const LEGACY_OFFICE = new Set(['.doc', '.ppt', '.xls', '.rtf']);

/** Images are base64'd into the request, which inflates them by a third. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let counter = 0;

export function attachmentPickerFilters(): Record<string, string[]> {
  return {
    'All supported': [
      'png', 'jpg', 'jpeg', 'gif', 'webp',
      'pdf', 'docx', 'pptx', 'xlsx',
      'txt', 'md', 'json', 'html', 'htm', 'csv', 'tsv', 'xml', 'yaml', 'yml',
      'ts', 'tsx', 'js', 'jsx', 'py', 'cs', 'java', 'go', 'rb', 'php',
      'sql', 'sh', 'ps1', 'css', 'scss', 'log', 'ini', 'toml', 'env'
    ],
    Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    Documents: ['pdf', 'docx', 'pptx', 'xlsx'],
    'Text and code': [
      'txt', 'md', 'json', 'html', 'htm', 'csv', 'tsv', 'xml', 'yaml', 'yml',
      'ts', 'tsx', 'js', 'jsx', 'py', 'cs', 'java', 'go', 'rb', 'php',
      'sql', 'sh', 'ps1', 'css', 'scss', 'log', 'ini', 'toml'
    ],
    'All files': ['*']
  };
}

export async function readAttachment(
  uri: vscode.Uri,
  settings: Settings
): Promise<Attachment> {
  const fsPath = uri.fsPath;
  const name = path.basename(fsPath);
  const ext = path.extname(fsPath).toLowerCase();
  const id = `att-${Date.now()}-${++counter}`;

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    return {
      id, fsPath, name, kind: 'unsupported', bytes: 0,
      error: `Could not read the file: ${(e as Error).message}`
    };
  }

  const size = bytes.byteLength;
  const base: Attachment = { id, fsPath, name, kind: 'text', bytes: size };
  const buf = Buffer.from(bytes);

  // --- images -------------------------------------------------------------
  if (IMAGE_MIME[ext]) {
    if (size > MAX_IMAGE_BYTES) {
      return {
        ...base, kind: 'unsupported',
        error: `Image is ${formatBytes(size)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}. Resize it and try again.`
      };
    }
    return {
      ...base,
      kind: 'image',
      mime: IMAGE_MIME[ext],
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`
    };
  }

  if (ext === '.bmp' || ext === '.tif' || ext === '.tiff' || ext === '.svg') {
    return {
      ...base, kind: 'unsupported',
      error: `${ext} images are not accepted by the vision API. Convert to PNG, JPEG, GIF or WebP first.`
    };
  }

  // --- documents ----------------------------------------------------------
  try {
    if (ext === '.pdf') {
      const r = extractPdf(buf);
      if (r.looksScanned) {
        return {
          ...base, kind: 'document', text: '',
          note: `${r.pageCount} page(s), but no text layer — this looks like a scan. Attach a page as an image instead so the model can read it.`
        };
      }
      return {
        ...base, kind: 'document',
        ...truncate(r.text, settings.maxFileBytes),
        note: `${r.pageCount} page(s)`
      };
    }

    if (ext === '.docx' || ext === '.docm' || ext === '.dotx') {
      return { ...base, kind: 'document', ...truncate(extractDocx(buf), settings.maxFileBytes) };
    }
    if (ext === '.pptx' || ext === '.pptm') {
      return { ...base, kind: 'document', ...truncate(extractPptx(buf), settings.maxFileBytes) };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      return { ...base, kind: 'document', ...truncate(extractXlsx(buf), settings.maxFileBytes) };
    }
  } catch (e) {
    return {
      ...base, kind: 'unsupported',
      error: `Could not read this ${ext} file: ${(e as Error).message}`
    };
  }

  if (LEGACY_OFFICE.has(ext)) {
    return {
      ...base, kind: 'unsupported',
      error: `${ext} is the old binary Office format. Save it as ${ext}x and attach that.`
    };
  }

  // --- plain text and code ------------------------------------------------
  if (looksBinary(buf)) {
    return {
      ...base, kind: 'unsupported',
      error: 'This looks like a binary file, so there is no text to read.'
    };
  }

  return { ...base, kind: 'text', ...truncate(buf.toString('utf8'), settings.maxFileBytes) };
}

function truncate(text: string, limit: number): { text: string; note?: string } {
  if (text.length <= limit) {
    return { text };
  }
  return {
    text: text.slice(0, limit),
    note: `truncated to the first ${formatBytes(limit)} of ${formatBytes(text.length)}`
  };
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  if (sample.includes(0)) {
    return true;
  }
  // A high proportion of non-printable bytes also means binary.
  let odd = 0;
  for (const b of sample) {
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return sample.length > 0 && odd / sample.length > 0.15;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A short language hint for the fenced block wrapping a text attachment. */
function fenceLanguage(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.py': 'python',
    '.cs': 'csharp', '.java': 'java', '.go': 'go', '.rb': 'ruby',
    '.php': 'php', '.sql': 'sql', '.sh': 'bash', '.ps1': 'powershell',
    '.json': 'json', '.html': 'html', '.htm': 'html', '.xml': 'xml',
    '.css': 'css', '.scss': 'scss', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.csv': 'csv', '.toml': 'toml', '.ini': 'ini'
  };
  return map[ext] ?? 'text';
}

/**
 * Turns attachments into the content parts of a user message. Text and
 * documents become fenced blocks; images become image_url parts, which is
 * what the Azure vision-capable deployments expect.
 */
export function attachmentsToContentParts(
  attachments: Attachment[]
): ContentPart[] {
  const parts: ContentPart[] = [];

  for (const a of attachments) {
    if (a.kind === 'image' && a.dataUrl) {
      parts.push({ type: 'text', text: `[Attached image: ${a.name}]` });
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl, detail: 'auto' } });
      continue;
    }

    if (a.error) {
      parts.push({ type: 'text', text: `[Attachment ${a.name} could not be read: ${a.error}]` });
      continue;
    }

    const header = `[Attached file: ${a.name}${a.note ? ` — ${a.note}` : ''}]`;
    if (!a.text || !a.text.trim()) {
      parts.push({ type: 'text', text: `${header}\n(no readable text)` });
      continue;
    }

    const lang = a.kind === 'document' ? 'text' : fenceLanguage(a.name);
    parts.push({
      type: 'text',
      text: `${header}\n\`\`\`${lang}\n${a.text}\n\`\`\``
    });
  }

  return parts;
}

/** True when any attachment needs a vision-capable deployment. */
export function hasImages(attachments: Attachment[]): boolean {
  return attachments.some((a) => a.kind === 'image');
}
