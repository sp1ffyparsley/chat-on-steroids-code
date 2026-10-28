/**
 * ChatGPT's drawn answers (DIL) come with a Markdown version that can leave parts out (#1477,
 * 2026-10-15): a table with only its header row, and a button as a bare "[label]" line. The
 * recorded drawing has the rows. Adapted from @Maximapple's upstream #1520 / commits
 * 9a4a3157 and c77eabd8. This fork fills only a unique header-only table in its existing
 * renderer; its absent upstream Copy/Markdown-export feature is not introduced here.
 * Canonical body rows, quoted examples and ambiguous/stale-looking captures stay unchanged.
 */
import { plainTextOfHtml } from './content-reference.js';

const cellText = (value: string): string => value.replace(/\s+/g, ' ').trim();
const markdownCells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => cellText(value.replace(/\\\|/g, '|').replace(/\*\*/g, '')));
// These values are captured plain text, not authored Markdown. Preserve literal
// backslashes, pipes, links, emphasis and HTML instead of creating markup/actions.
const escapeCell = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
  .replace(/[&<>`*_\[\]()~!]/g, value => `&#${value.charCodeAt(0)};`)
  .replace(/:(?=\/\/)/g, '&#58;');
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const MAX_CAPTURE_CHARS = 256 * 1024;

/** The rows of each table ChatGPT drew, as cell texts. */
function drawnTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const marked of html.split(/data-d-component="table"/).slice(1)) {
    const table = marked.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!table) continue;
    tables.push([...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([row]) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => cellText(plainTextOfHtml(cell ?? '')))));
  }
  return tables;
}

export function completedDilText(text: string, capture?: { text: string; truncated?: boolean } | null): string {
  if (!capture?.text || capture.truncated || text.length > MAX_CAPTURE_CHARS ||
      capture.text.length > MAX_CAPTURE_CHARS || !capture.text.includes('data-d-component')) return text;
  let tables: string[][][];
  let buttons: Set<string>;
  try {
    tables = drawnTables(capture.text);
    buttons = new Set([...capture.text.matchAll(/<button\b[^>]*data-d-component="button"[^>]*>([\s\S]*?)<\/button>/gi)]
      .map(([, inner]) => cellText(plainTextOfHtml(inner ?? ''))).filter(Boolean));
  } catch { return text; } // Malformed captured entities cannot break the canonical answer.
  if (!tables.length && !buttons.size) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let fence = '';
  let fenceLength = 0;
  let completedTable = false;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push(line);
      if (marker && marker[1]![0] === fence && marker[1]!.length >= fenceLength && !marker[2]!.trim()) fence = '';
      continue;
    }
    if (marker && (marker[1]![0] === '~' || !marker[2]!.includes('`'))) {
      fence = marker[1]![0]!; fenceLength = marker[1]!.length; out.push(line); continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { out.push(line); continue; }
    const label = line.trim().match(/^\[([^\]]+)\]$/)?.[1];
    if (completedTable && label && buttons.has(cellText(label))) {
      // A dead button label, and the blank line it leaves behind.
      if (out.length > 0 && out.at(-1)!.trim() === '' && lines[at + 1]?.trim() === '') at++;
      continue;
    }
    out.push(line);
    if (!line.trim().startsWith('|') || !SEPARATOR.test(lines[at + 1] ?? '')) continue;
    const header = markdownCells(line);
    let body = 0;
    while ((lines[at + 2 + body] ?? '').trim().startsWith('|')) body++;
    if (body > 0) continue; // Captured DOM is not authority to replace canonical rows.
    const matches = tables.filter(rows => rows.length > 1 && rows[0]!.length === header.length &&
      rows.every(row => row.length === header.length) &&
      rows[0]!.every((value, index) => value === header[index]));
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    out.push(lines[at + 1]!);
    for (const row of match.slice(1)) out.push(`| ${row.map(escapeCell).join(' | ')} |`);
    completedTable = true;
    at += 1 + body;
  }
  return out.join('\n');
}
