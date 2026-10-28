import { constants, promises as fs } from 'node:fs';

/** Bound allocation even if a regular file grows after stat; close the same read handle on every exit. */
export async function readAuthoredBytes(file, maxBytes = 4 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Authored file byte limit must be a positive safe integer');
  // POSIX FIFOs must not block open before the regular-file check can reject them.
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error(`${file} must be a regular text file`);
    if (stat.size > BigInt(maxBytes)) throw new Error(`${file} exceeds the ${maxBytes}-byte authored file limit`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) {
        const after = await handle.stat({ bigint: true });
        const current = await fs.stat(file, { bigint: true });
        // Recheck the path as well as its open handle: editors commonly save by rename.
        // BigInt preserves full Windows file IDs and nanosecond timestamps.
        if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs ||
            BigInt(length) !== stat.size || current.dev !== stat.dev || current.ino !== stat.ino ||
            current.size !== stat.size || current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs)
          throw new Error(`${file} changed while being read; save the source and retry before queueing`);
        return buffer.subarray(0, length);
      }
      length += bytesRead;
      if (length > maxBytes) throw new Error(`${file} exceeds the ${maxBytes}-byte authored file limit`);
    }
    throw new Error(`${file} could not be read within the authored file limit`);
  } finally {
    await handle.close();
  }
}

/** Decode strict UTF-8 or BOM-marked UTF-16 without silently replacing malformed binary bytes. */
export function decodeAuthoredText(bytes, label = 'text file') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let encoding = 'utf-8';
  let start = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf-16le';
    start = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf-16be';
    start = 2;
  } else {
    start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  }
  if (encoding !== 'utf-8' && (buffer.length - start) % 2 !== 0)
    throw new Error(`${label} has a truncated ${encoding === 'utf-16be' ? 'UTF-16BE' : 'UTF-16LE'} code unit`);
  let text;
  try {
    // The encoding BOM was removed explicitly; preserve a second authored U+FEFF.
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buffer.subarray(start));
  } catch (cause) {
    throw new Error(`${label} is not valid ${encoding} text; check for binary data or a damaged export`, { cause });
  }
  if (text.includes('\u0000')) throw new Error(`${label} contains unsupported NUL characters`);
  if (/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) throw new Error(`${label} contains unsupported binary control characters`);
  return text;
}
