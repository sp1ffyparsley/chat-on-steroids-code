import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The production packaging helper is intentionally plain ESM JavaScript.
import { decodeAuthoredText, readAuthoredBytes } from '../scripts/authored-text.mjs';

describe('authored text file decoding', () => {
  it('decodes UTF-8 and strips its optional BOM', () => {
    expect(decodeAuthoredText(Buffer.from('\ufeffLoop text', 'utf8'))).toBe('Loop text');
    expect(decodeAuthoredText(Buffer.from('Prompt text', 'utf8'))).toBe('Prompt text');
  });

  it('decodes Windows UTF-16LE exports without embedded NULs', () => {
    const body = Buffer.from('Keep working — production', 'utf16le');
    expect(decodeAuthoredText(Buffer.concat([Buffer.from([0xff, 0xfe]), body]))).toBe('Keep working — production');
  });

  it('decodes UTF-16BE and rejects malformed or binary text', () => {
    const body = Buffer.from('Loop', 'utf16le');
    body.swap16();
    expect(decodeAuthoredText(Buffer.concat([Buffer.from([0xfe, 0xff]), body]))).toBe('Loop');
    expect(() => decodeAuthoredText(Buffer.from([0xfe, 0xff, 0x00]))).toThrow('truncated UTF-16BE');
    expect(() => decodeAuthoredText(Buffer.from('bad\0text'))).toThrow('NUL');
  });

  it('rejects invalid UTF-8, truncated UTF-16LE and unpaired UTF-16 surrogates', () => {
    expect(() => decodeAuthoredText(Buffer.from([0xc3, 0x28]))).toThrow('not valid utf-8');
    expect(() => decodeAuthoredText(Buffer.from([0xff, 0xfe, 0x41]))).toThrow('truncated UTF-16LE');
    expect(() => decodeAuthoredText(Buffer.from([0xff, 0xfe, 0x00, 0xd8]))).toThrow('not valid utf-16le');
    expect(() => decodeAuthoredText(Buffer.from('binary\u0001data'))).toThrow('binary control');
    expect(decodeAuthoredText(Buffer.from('\ufeff\ufeffKeep authored BOM'))).toBe('\ufeffKeep authored BOM');
  });

  it('reads up to the byte limit and closes rejected files for a subsequent valid read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'authored-text-'));
    const file = path.join(root, 'prompt.txt');
    try {
      await writeFile(file, '1234');
      expect((await readAuthoredBytes(file, 4)).toString()).toBe('1234');
      await expect(readAuthoredBytes(file, 3)).rejects.toThrow('authored file limit');
      await writeFile(file, 'ok');
      expect((await readAuthoredBytes(file, 3)).toString()).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
