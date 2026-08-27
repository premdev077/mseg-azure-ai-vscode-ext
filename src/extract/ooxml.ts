import { readMatchingEntries, readNamedEntry } from './zip';

/** Decodes the five XML predefined entities plus numeric references. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Pulls the text out of an OOXML part. `textTag` is the local name of the
 * run-text element (`t` for Word and PowerPoint), and the paragraph/break tags
 * are turned into newlines so the extracted text keeps its shape.
 */
function extractFromXml(xml: string, textTag: string, paragraphTags: string[]): string {
  // Normalise structural tags to markers before stripping the rest.
  let s = xml;
  for (const tag of paragraphTags) {
    s = s.replace(new RegExp(`</w?a?:?${tag}>`, 'g'), '');
    s = s.replace(new RegExp(`<[a-z]*:?${tag}\\b[^>]*/>`, 'g'), '');
  }
  s = s.replace(/<[a-z]*:?br\b[^>]*\/?>/g, '');
  s = s.replace(/<[a-z]*:?tab\b[^>]*\/?>/g, '\t');

  const out: string[] = [];
  const re = new RegExp(
    `<([a-z]+:)?${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z]+:)?${textTag}>|`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') {
      out.push('\n');
    } else {
      out.push(decodeEntities(m[2] ?? ''));
    }
  }

  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocx(buf: Buffer): string {
  const parts: string[] = [];

  const body = readNamedEntry(buf, 'word/document.xml');
  if (!body) {
    throw new Error('Not a Word document (word/document.xml is missing).');
  }
  parts.push(extractFromXml(body.toString('utf8'), 't', ['p']));

  // Headers, footers and footnotes often carry meaningful content.
  for (const { name, data } of readMatchingEntries(buf, (n) =>
    /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n)
  )) {
    const text = extractFromXml(data.toString('utf8'), 't', ['p']);
    if (text.trim()) {
      parts.push(`\n[${name}]\n${text}`);
    }
  }

  return parts.join('\n').trim();
}

export function extractPptx(buf: Buffer): string {
  const slides = readMatchingEntries(buf, (n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n)
  ).sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  if (slides.length === 0) {
    throw new Error('Not a PowerPoint file (no slides found).');
  }

  const notes = new Map<number, string>();
  for (const { name, data } of readMatchingEntries(buf, (n) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)
  )) {
    notes.set(
      slideNumber(name),
      extractFromXml(data.toString('utf8'), 't', ['p'])
    );
  }

  return slides
    .map(({ name, data }) => {
      const n = slideNumber(name);
      const body = extractFromXml(data.toString('utf8'), 't', ['p']);
      const note = notes.get(n);
      return `--- Slide ${n} ---\n${body}${
        note && note.trim() ? `\n\n[Speaker notes]\n${note}` : ''
      }`;
    })
    .join('\n\n');
}

function slideNumber(name: string): number {
  const m = name.match(/(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Renders a workbook as one TSV block per sheet. Values come from the shared
 * string table for text cells and from the inline value for everything else;
 * formulas are reported by their cached result, which is what a reader cares
 * about.
 */
export function extractXlsx(buf: Buffer): string {
  const sharedXml = readNamedEntry(buf, 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedXml) {
    const xml = sharedXml.toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml)) !== null) {
      const text = (m[1].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? [])
        .map((t) => decodeEntities(t.replace(/<[^>]+>/g, '')))
        .join('');
      shared.push(text);
    }
  }

  const names = sheetNames(buf);
  const sheets = readMatchingEntries(buf, (n) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  ).sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  if (sheets.length === 0) {
    throw new Error('Not an Excel workbook (no worksheets found).');
  }

  const blocks: string[] = [];
  for (const { name, data } of sheets) {
    const idx = slideNumber(name);
    const title = names[idx - 1] ?? `Sheet${idx}`;
    const xml = data.toString('utf8');
    const rows: string[] = [];

    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(xml)) !== null && rows.length < 2000) {
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1] ?? '';
        const inner = cm[2] ?? '';
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        let value = '';

        if (type === 'inlineStr') {
          value = (inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? [])
            .map((t) => decodeEntities(t.replace(/<[^>]+>/g, '')))
            .join('');
        } else {
          const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (v !== undefined) {
            value =
              type === 's'
                ? shared[parseInt(v, 10)] ?? ''
                : decodeEntities(v);
          }
        }
        cells.push(value);
      }
      if (cells.some((c) => c !== '')) {
        rows.push(cells.join('\t'));
      }
    }

    blocks.push(`--- Sheet: ${title} ---\n${rows.join('\n')}`);
  }

  return blocks.join('\n\n');
}

function sheetNames(buf: Buffer): string[] {
  const wb = readNamedEntry(buf, 'xl/workbook.xml');
  if (!wb) {
    return [];
  }
  const out: string[] = [];
  const re = /<sheet\b[^>]*name="([^"]*)"[^>]*>/g;
  let m: RegExpExecArray | null;
  const xml = wb.toString('utf8');
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeEntities(m[1]));
  }
  return out;
}
