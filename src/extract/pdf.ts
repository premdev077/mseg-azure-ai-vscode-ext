import * as zlib from 'zlib';

/**
 * A dependency-free PDF text extractor.
 *
 * It parses the object graph (including PDF 1.5+ object streams), walks the
 * page tree so each content stream is decoded with the fonts that page
 * actually declares, and maps character codes through /ToUnicode CMaps — which
 * is what makes text from Word- and browser-generated PDFs come out as real
 * words rather than mojibake.
 *
 * It deliberately does not attempt OCR. A scanned PDF has no text objects at
 * all, and `extractPdf` reports that instead of returning silence.
 */

type PdfName = { name: string };
type PdfRef = { ref: number; gen: number };
type PdfDict = Map<string, PdfValue>;
type PdfValue =
  | number
  | string
  | boolean
  | null
  | PdfName
  | PdfRef
  | PdfValue[]
  | PdfDict
  | { dict: PdfDict; streamStart: number; streamEnd: number };

type MaybeValue = PdfValue | undefined;

const isName = (v: MaybeValue): v is PdfName =>
  typeof v === 'object' && v !== null && 'name' in v;
const isRef = (v: MaybeValue): v is PdfRef =>
  typeof v === 'object' && v !== null && 'ref' in v;
const isDict = (v: MaybeValue): v is PdfDict => v instanceof Map;
const isStream = (
  v: MaybeValue
): v is { dict: PdfDict; streamStart: number; streamEnd: number } =>
  typeof v === 'object' && v !== null && 'streamStart' in v;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25
]);

class Lexer {
  constructor(
    public buf: Buffer,
    public pos = 0
  ) {}

  skipWs(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (WHITESPACE.has(c)) {
        this.pos++;
      } else if (c === 0x25) {
        // comment to end of line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a) {
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  readToken(): string {
    this.skipWs();
    const start = this.pos;
    while (
      this.pos < this.buf.length &&
      !WHITESPACE.has(this.buf[this.pos]) &&
      !DELIMITERS.has(this.buf[this.pos])
    ) {
      this.pos++;
    }
    if (this.pos === start) {
      this.pos++;
      return this.buf.toString('latin1', start, this.pos);
    }
    return this.buf.toString('latin1', start, this.pos);
  }

  peek(): number {
    this.skipWs();
    return this.buf[this.pos];
  }

  parseValue(depth = 0): PdfValue {
    if (depth > 48) {
      return null;
    }
    this.skipWs();
    if (this.pos >= this.buf.length) {
      return null;
    }
    const c = this.buf[this.pos];

    if (c === 0x2f) {
      this.pos++;
      const start = this.pos;
      while (
        this.pos < this.buf.length &&
        !WHITESPACE.has(this.buf[this.pos]) &&
        !DELIMITERS.has(this.buf[this.pos])
      ) {
        this.pos++;
      }
      const raw = this.buf.toString('latin1', start, this.pos);
      return {
        name: raw.replace(/#([0-9a-fA-F]{2})/g, (_m: string, h: string) =>
          String.fromCharCode(parseInt(h, 16))
        )
      };
    }

    if (c === 0x28) {
      return this.parseLiteralString();
    }

    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) {
        return this.parseDictOrStream(depth);
      }
      return this.parseHexString();
    }

    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= this.buf.length || this.buf[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        arr.push(this.parseValue(depth + 1));
      }
      return arr;
    }

    // number, ref, keyword
    const save = this.pos;
    const tok = this.readToken();
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(tok)) {
      // Might be "N G R" (an indirect reference).
      const after = this.pos;
      const t2 = this.readToken();
      if (/^\d+$/.test(t2)) {
        const t3 = this.readToken();
        if (t3 === 'R') {
          return { ref: parseInt(tok, 10), gen: parseInt(t2, 10) };
        }
      }
      this.pos = after;
      return parseFloat(tok);
    }

    if (tok === '') {
      this.pos = save + 1;
      return null;
    }
    return { name: tok };
  }

  parseLiteralString(): string {
    this.pos++; // (
    let depth = 1;
    const out: number[] = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0x5c) {
        const n = this.buf[this.pos++];
        switch (n) {
          case 0x6e:
            out.push(10);
            break;
          case 0x72:
            out.push(13);
            break;
          case 0x74:
            out.push(9);
            break;
          case 0x62:
            out.push(8);
            break;
          case 0x66:
            out.push(12);
            break;
          case 0x0a:
            break; // line continuation
          case 0x0d:
            if (this.buf[this.pos] === 0x0a) this.pos++;
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let oct = String.fromCharCode(n);
              for (let k = 0; k < 2; k++) {
                const d = this.buf[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  oct += String.fromCharCode(d);
                  this.pos++;
                } else break;
              }
              out.push(parseInt(oct, 8) & 0xff);
            } else {
              out.push(n);
            }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else {
        out.push(c);
      }
    }
    return Buffer.from(out).toString('latin1');
  }

  parseHexString(): string {
    this.pos++; // <
    let hex = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(this.buf[this.pos++]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.pos++; // >
    if (hex.length % 2) hex += '0';
    let s = '';
    for (let i = 0; i < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return s;
  }

  parseDictOrStream(depth: number): PdfValue {
    this.pos += 2; // <<
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.parseValue(depth + 1);
      if (!isName(key)) {
        // Malformed; bail rather than spin.
        if (this.pos >= this.buf.length) break;
        continue;
      }
      dict.set(key.name, this.parseValue(depth + 1));
    }

    const save = this.pos;
    this.skipWs();
    if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6;
      if (this.buf[this.pos] === 0x0d) this.pos++;
      if (this.buf[this.pos] === 0x0a) this.pos++;
      const streamStart = this.pos;
      const end = this.buf.indexOf('endstream', streamStart, 'latin1');
      const streamEnd = end === -1 ? this.buf.length : end;
      this.pos = end === -1 ? this.buf.length : end + 9;
      return { dict, streamStart, streamEnd };
    }
    this.pos = save;
    return dict;
  }
}

export class PdfDocument {
  private objects = new Map<number, PdfValue>();

  constructor(private buf: Buffer) {
    this.parseAllObjects();
    this.expandObjectStreams();
  }

  private parseAllObjects(): void {
    // Scanning for "N G obj" is more forgiving than trusting the xref table,
    // which is frequently stale in files edited by other tools.
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const text = this.buf.toString('latin1');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      const lexer = new Lexer(this.buf, m.index + m[0].length);
      try {
        this.objects.set(num, lexer.parseValue());
      } catch {
        /* skip unparsable object */
      }
    }
  }

  private expandObjectStreams(): void {
    for (const [, value] of [...this.objects]) {
      if (!isStream(value)) continue;
      const type = value.dict.get('Type');
      if (!isName(type) || type.name !== 'ObjStm') continue;

      let data: Buffer;
      try {
        data = this.decodeStream(value);
      } catch {
        continue;
      }
      const n = Number(this.resolve(value.dict.get('N')) ?? 0);
      const first = Number(this.resolve(value.dict.get('First')) ?? 0);
      const header = data.toString('latin1', 0, first);
      const nums = header.trim().split(/\s+/).map(Number);

      for (let i = 0; i < n; i++) {
        const objNum = nums[i * 2];
        const offset = nums[i * 2 + 1];
        if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue;
        if (this.objects.has(objNum)) continue;
        try {
          this.objects.set(objNum, new Lexer(data, first + offset).parseValue());
        } catch {
          /* skip */
        }
      }
    }
  }

  resolve(v: MaybeValue): MaybeValue {
    let seen = 0;
    while (isRef(v) && seen++ < 32) {
      v = this.objects.get(v.ref);
    }
    return v;
  }

  decodeStream(s: { dict: PdfDict; streamStart: number; streamEnd: number }): Buffer {
    let raw = this.buf.subarray(s.streamStart, s.streamEnd);

    // Trust /Length when it is sane; the endstream scan can overshoot if the
    // stream data happens to contain the word.
    const len = this.resolve(s.dict.get('Length'));
    if (typeof len === 'number' && len > 0 && len <= raw.length) {
      raw = raw.subarray(0, len);
    }

    const filter = this.resolve(s.dict.get('Filter'));
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];

    let data: Buffer = Buffer.from(new Uint8Array(raw));
    for (const f of filters) {
      const fn = this.resolve(f);
      if (!isName(fn)) continue;
      switch (fn.name) {
        case 'FlateDecode':
          data = inflateTolerant(data);
          break;
        case 'ASCIIHexDecode':
          data = decodeAsciiHex(data);
          break;
        case 'ASCII85Decode':
          data = decodeAscii85(data);
          break;
        case 'DCTDecode':
        case 'JPXDecode':
        case 'CCITTFaxDecode':
        case 'JBIG2Decode':
          // An image, not text.
          return Buffer.alloc(0);
        default:
          break;
      }
    }

    const parms = this.resolve(s.dict.get('DecodeParms'));
    const p = Array.isArray(parms) ? this.resolve(parms[0]) : parms;
    if (isDict(p)) {
      const predictor = Number(this.resolve(p.get('Predictor')) ?? 1);
      if (predictor >= 10) {
        const columns = Number(this.resolve(p.get('Columns')) ?? 1);
        const colors = Number(this.resolve(p.get('Colors')) ?? 1);
        const bpc = Number(this.resolve(p.get('BitsPerComponent')) ?? 8);
        data = undoPngPredictor(data, columns, colors, bpc);
      }
    }

    return data;
  }

  /** Pages in document order, each with its content bytes and font map. */
  pages(): Array<{ content: Buffer; fonts: Map<string, FontInfo> }> {
    const root = this.findCatalog();
    const pageDicts: PdfDict[] = [];

    if (root) {
      const pagesRef = root.get('Pages');
      const pages = this.resolve(pagesRef);
      if (isDict(pages)) {
        this.collectPages(pages, pageDicts, new Set(), {});
      }
    }

    if (pageDicts.length === 0) {
      // No usable page tree: fall back to every object that calls itself a Page.
      for (const [, v] of this.objects) {
        const d = isStream(v) ? v.dict : v;
        if (isDict(d)) {
          const t = this.resolve(d.get('Type'));
          if (isName(t) && t.name === 'Page') pageDicts.push(d);
        }
      }
    }

    return pageDicts.map((page) => ({
      content: this.pageContent(page),
      fonts: this.pageFonts(page)
    }));
  }

  private findCatalog(): PdfDict | undefined {
    for (const [, v] of this.objects) {
      const d = isStream(v) ? v.dict : v;
      if (isDict(d)) {
        const t = this.resolve(d.get('Type'));
        if (isName(t) && t.name === 'Catalog') return d;
      }
    }
    return undefined;
  }

  private collectPages(
    node: PdfDict,
    out: PdfDict[],
    seen: Set<PdfDict>,
    inherited: { Resources?: PdfValue }
  ): void {
    if (seen.has(node) || out.length > 5000) return;
    seen.add(node);

    const type = this.resolve(node.get('Type'));
    const res = node.get('Resources') ?? inherited.Resources;

    if (isName(type) && type.name === 'Page') {
      if (res !== undefined && !node.has('Resources')) {
        node.set('Resources', res);
      }
      out.push(node);
      return;
    }

    const kids = this.resolve(node.get('Kids'));
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        const k = this.resolve(kid);
        if (isDict(k)) {
          this.collectPages(k, out, seen, { Resources: res });
        }
      }
    }
  }

  private pageContent(page: PdfDict): Buffer {
    const contents = this.resolve(page.get('Contents'));
    const streams = Array.isArray(contents) ? contents : [contents];
    const chunks: Buffer[] = [];
    for (const c of streams) {
      const s = this.resolve(c);
      if (isStream(s)) {
        try {
          chunks.push(this.decodeStream(s));
        } catch {
          /* skip undecodable stream */
        }
      }
    }
    return Buffer.concat(chunks.length ? chunks : [Buffer.alloc(0)]);
  }

  private pageFonts(page: PdfDict): Map<string, FontInfo> {
    const fonts = new Map<string, FontInfo>();
    const res = this.resolve(page.get('Resources'));
    if (!isDict(res)) return fonts;
    const fontDict = this.resolve(res.get('Font'));
    if (!isDict(fontDict)) return fonts;

    for (const [alias, ref] of fontDict) {
      const font = this.resolve(ref);
      if (!isDict(font)) continue;

      const subtype = this.resolve(font.get('Subtype'));
      const isType0 = isName(subtype) && subtype.name === 'Type0';

      let toUnicode: Map<number, string> | undefined;
      const tu = this.resolve(font.get('ToUnicode'));
      if (isStream(tu)) {
        try {
          toUnicode = parseCMap(this.decodeStream(tu).toString('latin1'));
        } catch {
          /* no cmap */
        }
      }

      fonts.set(alias, { twoByte: isType0, toUnicode });
    }
    return fonts;
  }
}

export interface FontInfo {
  twoByte: boolean;
  toUnicode?: Map<number, string>;
}

/** Parses the bfchar/bfrange sections of a ToUnicode CMap. */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToStr = (h: string): string => {
    let s = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) {
      const unit = parseInt(h.slice(i, i + 4), 16);
      if (!Number.isNaN(unit)) s += String.fromCharCode(unit);
    }
    return s;
  };

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = charRe.exec(cmap)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1])) !== null) {
      map.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(cmap)) !== null) {
    const body = m[1];
    const simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let r: RegExpExecArray | null;
    while ((r = simple.exec(body)) !== null) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const base = parseInt(r[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) {
        map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
    const arrayForm = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    while ((r = arrayForm.exec(body)) !== null) {
      const lo = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9a-fA-F]+)>/g) ?? [];
      items.forEach((item, i) => {
        map.set(lo + i, hexToStr(item.slice(1, -1)));
      });
    }
  }

  return map;
}

/** Runs the text-showing operators of one content stream. */
function extractPageText(content: Buffer, fonts: Map<string, FontInfo>): string {
  const lexer = new Lexer(content);
  const out: string[] = [];
  let currentFont: FontInfo | undefined;
  let pendingOperands: PdfValue[] = [];
  // Vertical position of the current text line. A horizontal-only move is
  // kerning or a style change mid-sentence, not a line break — treating every
  // Td/Tm as a newline is what splits "Fletcher acquisition" across lines.
  let lineY: number | undefined;

  const numAt = (i: number): number | undefined => {
    const v = pendingOperands[pendingOperands.length + i];
    return typeof v === 'number' ? v : undefined;
  };

  const moveTo = (y: number | undefined, relative: boolean): void => {
    if (y === undefined) {
      out.push('\n');
      return;
    }
    if (relative) {
      if (Math.abs(y) > 0.1) {
        out.push('\n');
        lineY = undefined;
      }
      return;
    }
    if (lineY === undefined || Math.abs(y - lineY) > 0.1) {
      if (lineY !== undefined) out.push('\n');
      lineY = y;
    }
  };

  const decode = (s: string): string => {
    const font = currentFont;
    if (!font) return s;

    if (font.twoByte) {
      let text = '';
      for (let i = 0; i + 1 < s.length; i += 2) {
        const code = (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1);
        text += font.toUnicode?.get(code) ?? '';
      }
      return text;
    }

    if (font.toUnicode && font.toUnicode.size) {
      let text = '';
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        text += font.toUnicode.get(code) ?? s[i];
      }
      return text;
    }
    return s;
  };

  while (lexer.pos < content.length) {
    lexer.skipWs();
    if (lexer.pos >= content.length) break;

    const c = content[lexer.pos];
    if (
      c === 0x28 ||
      c === 0x3c ||
      c === 0x5b ||
      c === 0x2f ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2d ||
      c === 0x2e
    ) {
      const before = lexer.pos;
      const v = lexer.parseValue();
      if (lexer.pos === before) lexer.pos++;
      pendingOperands.push(v);
      if (pendingOperands.length > 64) pendingOperands.shift();
      continue;
    }

    const op = lexer.readToken();
    switch (op) {
      case 'Tf': {
        const nameOperand = pendingOperands[pendingOperands.length - 2];
        if (isName(nameOperand)) {
          currentFont = fonts.get(nameOperand.name);
        }
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        const s = pendingOperands[pendingOperands.length - 1];
        if (typeof s === 'string') out.push(decode(s));
        if (op !== 'Tj') {
          out.push('\n');
          lineY = undefined;
        }
        break;
      }
      case 'TJ': {
        const arr = pendingOperands[pendingOperands.length - 1];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === 'string') {
              out.push(decode(item));
            } else if (typeof item === 'number' && item <= -120) {
              // A large negative adjustment is inter-word spacing.
              out.push(' ');
            }
          }
        }
        break;
      }
      case 'Td':
      case 'TD':
        // operands: tx ty
        moveTo(numAt(-1), true);
        break;
      case 'Tm':
        // operands: a b c d e f — f is the vertical translation
        moveTo(numAt(-1), false);
        break;
      case 'T*':
        out.push('\n');
        lineY = undefined;
        break;
      case 'BT':
        lineY = undefined;
        break;
      case 'ET':
        out.push('\n');
        lineY = undefined;
        break;
      default:
        break;
    }
    pendingOperands = [];
  }

  return out.join('');
}

function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface PdfExtraction {
  text: string;
  pageCount: number;
  /** True when the file parsed but contains no text objects (likely a scan). */
  looksScanned: boolean;
}

export function extractPdf(buf: Buffer): PdfExtraction {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Not a PDF file (missing %PDF- header).');
  }

  const doc = new PdfDocument(buf);
  const pages = doc.pages();
  const rendered: string[] = [];

  pages.forEach((page, i) => {
    const text = tidy(extractPageText(page.content, page.fonts));
    if (text) {
      rendered.push(`--- Page ${i + 1} ---\n${text}`);
    }
  });

  const text = rendered.join('\n\n');
  return {
    text,
    pageCount: pages.length,
    looksScanned: pages.length > 0 && text.replace(/\s/g, '').length < 20
  };
}

// --- stream filters -------------------------------------------------------

/** Inflates, tolerating the truncated//corrupt tails that real PDFs contain. */
function inflateTolerant(data: Buffer): Buffer {
  const attempts: Array<() => Buffer> = [
    () => zlib.inflateSync(data),
    () => zlib.inflateRawSync(data),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    // Some writers leave leading whitespace before the zlib header.
    () =>
      zlib.inflateSync(data.subarray(findZlibStart(data)), {
        finishFlush: zlib.constants.Z_SYNC_FLUSH
      })
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out.length) return out;
    } catch {
      /* try the next strategy */
    }
  }
  return Buffer.from(new Uint8Array(0));
}

function findZlibStart(data: Buffer): number {
  for (let i = 0; i < Math.min(data.length - 1, 32); i++) {
    if (data[i] === 0x78) return i;
  }
  return 0;
}

function decodeAsciiHex(data: Buffer): Buffer {
  const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
  return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
}

function decodeAscii85(data: Buffer): Buffer {
  let s = data.toString('latin1').replace(/\s/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end !== -1) s = s.slice(0, end);

  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (const ch of s) {
    if (ch === 'z' && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;
    tuple = tuple * 85 + v;
    if (++count === 5) {
      out.push(
        (tuple >>> 24) & 0xff,
        (tuple >>> 16) & 0xff,
        (tuple >>> 8) & 0xff,
        tuple & 0xff
      );
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [
      (tuple >>> 24) & 0xff,
      (tuple >>> 16) & 0xff,
      (tuple >>> 8) & 0xff,
      tuple & 0xff
    ];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function undoPngPredictor(
  data: Buffer,
  columns: number,
  colors: number,
  bpc: number
): Buffer {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  // Plain Uint8Arrays here: Buffer's generic parameter differs between
  // Buffer.alloc and Buffer.from(subarray) under recent @types/node.
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = new Uint8Array(
      data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen)
    );
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (type) {
        case 1:
          row[i] = (row[i] + a) & 0xff;
          break;
        case 2:
          row[i] = (row[i] + b) & 0xff;
          break;
        case 3:
          row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          row[i] = (row[i] + pred) & 0xff;
          break;
        }
        default:
          break;
      }
    }
    out.set(row, r * rowLen);
    prev = row;
  }
  return Buffer.from(out);
}
