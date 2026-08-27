import * as zlib from 'zlib';

/**
 * A minimal ZIP reader, enough to pull named entries out of an OOXML file
 * (.docx / .pptx / .xlsx are all ZIP containers).
 *
 * Written by hand rather than pulling in a dependency: Node ships the only
 * hard part (inflate) in `zlib`, and a corporate install is easier to approve
 * with zero runtime dependencies.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEocd(buf: Buffer): number {
  // The EOCD sits at the end, after a comment of up to 64 KiB.
  const minOffset = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

export function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd === -1) {
    throw new Error('Not a ZIP file (no end-of-central-directory record).');
  }

  let entryCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD.
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(eocd64) === EOCD64_SIG) {
        entryCount = Number(buf.readBigUInt64LE(eocd64 + 32));
        centralOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      break;
    }
    const compressionMethod = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extraStart = p + 46 + nameLen;
      let e = extraStart;
      while (e + 4 <= extraStart + extraLen) {
        const headerId = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        if (headerId === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buf.readBigUInt64LE(q));
          }
          break;
        }
        e += 4 + size;
      }
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP entry "${entry.name}".`);
  }
  // The local header's own size fields are unreliable when a data descriptor
  // is used, so the central directory's values are authoritative.
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(data);
  }
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(data);
  }
  throw new Error(
    `Unsupported ZIP compression method ${entry.compressionMethod} for "${entry.name}".`
  );
}

export function readNamedEntry(buf: Buffer, name: string): Buffer | undefined {
  const entry = listEntries(buf).find((e) => e.name === name);
  return entry ? readEntry(buf, entry) : undefined;
}

export function readMatchingEntries(
  buf: Buffer,
  test: (name: string) => boolean
): Array<{ name: string; data: Buffer }> {
  return listEntries(buf)
    .filter((e) => test(e.name))
    .map((e) => ({ name: e.name, data: readEntry(buf, e) }));
}
