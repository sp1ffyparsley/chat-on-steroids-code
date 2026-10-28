import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { Stats } from 'node:fs';
import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import type { SkillLibrary, SkillSummary } from '../shared/skills.js';
import { logInfo } from './logger.js';

export const SKILLS_DIRECTORY_NAME = 'skills';
export const SKILL_FILE_NAME = 'SKILL.md';
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_SKILLS = 128;
export const MAX_SKILL_DIRECTORY_ENTRIES = 512;
export const MAX_SKILL_ERRORS = 128;
export const MAX_SKILL_ID_LENGTH = 64;
export const MAX_SKILL_NAME_CHARS = 160;
export const MAX_SKILL_DESCRIPTION_CHARS = 1000;
export const MAX_SKILL_INTERFACE_BYTES = 64 * 1024;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const RESERVED_SKILL_IDS = ['prompt'] as const;

const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const RESERVED_SKILL_ID_SET = new Set<string>(RESERVED_SKILL_IDS);
const BINARY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DEFAULT_SKILLS_MARKER = '.cos-default-skills-v1';
const DEFAULT_DESIGN_SKILL = `---
name: Product Design
description: Design, implement, or review polished visual interfaces with responsive and accessible behavior.
cos-auto-select: visual-design-v1
---
# Product Design

Use this skill for an explicit visual, UI, UX, product-design, mockup, wireframe, or design-system task.

Before changing code, inspect the existing product, its components, and any supplied screenshots or references. Preserve established behavior and visual language unless the user asks for a redesign. Turn the request into a clear hierarchy, interaction model, and responsive layout before polishing details.

Prefer deliberate typography, spacing, color, contrast, and composition over generic card grids, excessive gradients, decorative clutter, or placeholder copy. Reuse the project's components and tokens when they are sound. Cover loading, empty, error, disabled, focus, hover, selected, and narrow-screen states that matter to the requested flow.

Implement the real experience with the tools available; do not stop at design advice when the user asked for working code. Keep accessibility concrete: semantic structure, keyboard access, visible focus, readable contrast, useful labels, and reduced-motion behavior where animation is used.

Verify the result at representative desktop and mobile widths. When visual inspection is available, inspect the rendered result and correct visible problems before reporting completion. Explain important design decisions briefly and call out any constraint that prevented faithful implementation.
`;

interface LibraryState {
  directory: string;
  directoryReal: string;
  userDataReal: string;
}

interface Frontmatter {
  exists: boolean;
  body: string;
  name?: string;
  description?: string;
}

interface ParsedSkill {
  name: string;
  description: string;
  nameSource: 'frontmatter' | 'title' | 'fallback';
  frontmatter: Frontmatter;
}

interface ManagedSkill {
  directory: string;
  directoryReal: string;
  directoryStat: Stats;
  file: string;
  fileStat: Stats;
}

export interface SkillTextIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

let library: LibraryState | null = null;
let mutations: Promise<unknown> = Promise.resolve();

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalRealpath(target: string): Promise<string> {
  return process.platform === 'win32' ? rawRealpathNative(target) : fs.realpath(target);
}

export function isSafeSkillId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > MAX_SKILL_ID_LENGTH || !SKILL_ID_PATTERN.test(id)) return false;
  return !RESERVED_SKILL_ID_SET.has(id) && !WINDOWS_RESERVED_STEMS.has(id.split('.')[0]!.toLowerCase());
}

function requireSkillId(id: string): void {
  if (!isSafeSkillId(id)) throw new Error('Skill id must be a safe lower-case file name');
}

function skillIdFrom(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_SKILL_ID_LENGTH)
    .replace(/[._-]+$/g, '');
  if (!isSafeSkillId(normalized)) throw new Error('Skill name does not produce a safe skill id');
  return normalized;
}

function fsErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
  if (a.dev !== 0 && b.dev !== 0 && a.ino !== 0 && b.ino !== 0) return a.dev === b.dev && a.ino === b.ino;
  return a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory();
}

function textIdentity(stat: Stats): SkillTextIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameTextIdentity(a: SkillTextIdentity, b: SkillTextIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function requireRoot(): Promise<LibraryState> {
  const current = library;
  if (!current) throw new Error('Skill library is not initialized');
  let stat: Stats;
  try {
    stat = await fs.lstat(current.directory);
  } catch {
    throw new Error('Skill library directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill library directory is unsafe');
  let real: string;
  try {
    real = await canonicalRealpath(current.directory);
  } catch {
    throw new Error('Skill library directory is unavailable');
  }
  if (!samePath(real, current.directoryReal) || !isContained(current.userDataReal, real) || samePath(current.userDataReal, real)) {
    throw new Error('Skill library directory changed on disk');
  }
  return current;
}

export interface InitSkillsOptions { installDefaults?: boolean }

async function installDefaultDesignSkill(userDataPath: string): Promise<void> {
  const root = await requireRoot();
  const marker = path.join(userDataPath, DEFAULT_SKILLS_MARKER);
  try {
    const markerStat = await fs.lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Default skill state marker is unsafe');
    return;
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') throw error;
  }

  const targetDirectory = path.join(root.directory, 'design');
  let created = false;
  try {
    await fs.mkdir(targetDirectory);
    created = true;
  } catch (error) {
    if (fsErrorCode(error) !== 'EEXIST') throw error;
  }
  const directoryStat = await fs.lstat(targetDirectory);
  const directoryReal = await canonicalRealpath(targetDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !isContained(root.directoryReal, directoryReal)) {
    throw new Error('Default design skill directory is unsafe');
  }
  const existingEntries = created ? [] : await fs.readdir(targetDirectory);
  if (created || existingEntries.length === 0) {
    try {
      await fs.writeFile(path.join(targetDirectory, SKILL_FILE_NAME), DEFAULT_DESIGN_SKILL, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      logInfo('skills: installed default /design skill');
    } catch (error) {
      if (created) {
        try { await fs.rmdir(targetDirectory); } catch { /* Preserve any concurrently created content. */ }
      }
      throw error;
    }
  }
  try {
    await fs.writeFile(marker, '1\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (fsErrorCode(error) !== 'EEXIST') throw error;
    const markerStat = await fs.lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Default skill state marker is unsafe');
  }
}

/** Initialize the private prompt-skill directory and seed removable defaults once per profile. */
export async function initSkills(userData: string, options: InitSkillsOptions = {}): Promise<void> {
  if (!path.isAbsolute(userData)) throw new Error('Skill userData path must be absolute');
  await mutations.catch(() => undefined);
  const userDataPath = path.resolve(userData);
  const directory = path.join(userDataPath, SKILLS_DIRECTORY_NAME);
  await fs.mkdir(directory, { recursive: true });
  const [userDataReal, directoryStat, directoryReal] = await Promise.all([
    canonicalRealpath(userDataPath),
    fs.lstat(directory),
    canonicalRealpath(directory),
  ]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Skill library directory is unsafe');
  if (!isContained(userDataReal, directoryReal) || samePath(userDataReal, directoryReal)) {
    throw new Error('Skill library must stay inside userData');
  }
  library = { directory, directoryReal, userDataReal };
  if (options.installDefaults !== false) await installDefaultDesignSkill(userDataPath);
}

export function skillsDirectory(): string | null {
  return library?.directoryReal ?? null;
}

async function readBoundedUtf8(file: string, expected?: Stats): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Skill content must be a regular file');
    if (expected && !sameFileIdentity(expected, opened)) throw new Error('Skill content changed during access');
    if (opened.size > MAX_SKILL_BYTES) throw new Error(`Skill content exceeds the ${MAX_SKILL_BYTES} byte limit`);

    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= MAX_SKILL_BYTES) {
      const remaining = MAX_SKILL_BYTES + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > MAX_SKILL_BYTES) throw new Error(`Skill content exceeds the ${MAX_SKILL_BYTES} byte limit`);

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error('Skill content is not valid UTF-8');
    }
    if (BINARY_CONTROL_CHARS.test(text)) throw new Error('Skill content looks binary or contains control bytes');
    return text;
  } finally {
    await handle.close();
  }
}

/** Stable bounded snapshot used by project/repository Skill discovery. */
export async function readSkillTextSnapshot(file: string): Promise<{ text: string; identity: SkillTextIdentity }> {
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Skill content must be a regular file');
    if (opened.size <= 0) throw new Error('Skill content must not be empty');
    if (opened.size > MAX_SKILL_BYTES) throw new Error(`Skill content exceeds the ${MAX_SKILL_BYTES} byte limit`);
    const before = textIdentity(opened);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('Skill content changed during access');
      offset += bytesRead;
    }
    const after = textIdentity(await handle.stat());
    if (!sameTextIdentity(before, after)) throw new Error('Skill content changed during access');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new Error('Skill content is not valid UTF-8');
    }
    if (BINARY_CONTROL_CHARS.test(text)) throw new Error('Skill content looks binary or contains control bytes');
    return { text, identity: before };
  } finally {
    await handle.close();
  }
}

function stripYamlComment(value: string): string {
  let quoted: 'single' | 'double' | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "'" && quoted !== 'double') {
      if (quoted === 'single' && value[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = quoted === 'single' ? null : 'single';
    } else if (char === '"' && quoted !== 'single' && value[i - 1] !== '\\') {
      quoted = quoted === 'double' ? null : 'double';
    } else if (char === '#' && quoted === null && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function yamlScalar(raw: string): string {
  const value = stripYamlComment(raw.trim()).trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function blockScalar(lines: string[], start: number, marker: string): { value: string; next: number } {
  const captured: string[] = [];
  let index = start;
  let minIndent = Number.POSITIVE_INFINITY;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === '') {
      captured.push('');
      continue;
    }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent === 0) break;
    minIndent = Math.min(minIndent, indent);
    captured.push(line);
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  const normalized = captured.map(line => line === '' ? '' : line.slice(minIndent));
  let value: string;
  if (marker.startsWith('>')) {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of normalized) {
      if (line === '') {
        if (current.length) paragraphs.push(current.join(' '));
        current = [];
      } else current.push(line.trim());
    }
    if (current.length) paragraphs.push(current.join(' '));
    value = paragraphs.join('\n\n');
  } else value = normalized.join('\n');
  if (!marker.endsWith('-') && value && normalized.length > 0) value += '\n';
  return { value, next: index };
}

function parseFrontmatter(text: string): Frontmatter {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { exists: false, body: source };
  let close = -1;
  for (let i = 1; i < Math.min(lines.length, 129); i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i]!)) {
      close = i;
      break;
    }
  }
  if (close < 0) return { exists: false, body: source };

  let name: string | undefined;
  let description: string | undefined;
  for (let i = 1; i < close;) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    if ((key === 'name' || key === 'description') && /^[>|][+-]?$/.test(raw.trim())) {
      const parsed = blockScalar(lines.slice(0, close), i + 1, raw.trim());
      if (key === 'name' && name === undefined) name = parsed.value;
      if (key === 'description' && description === undefined) description = parsed.value;
      i = parsed.next;
      continue;
    }
    if (key === 'name' && name === undefined) name = yamlScalar(raw);
    if (key === 'description' && description === undefined) description = yamlScalar(raw);
    i++;
  }
  return { exists: true, body: lines.slice(close + 1).join('\n'), name, description };
}

function cleanName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (name.length > MAX_SKILL_NAME_CHARS) throw new Error(`Skill name exceeds ${MAX_SKILL_NAME_CHARS} characters`);
  if (BINARY_CONTROL_CHARS.test(name)) throw new Error('Skill name contains control characters');
  return name;
}

function cleanDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const description = value.replace(/\r\n/g, '\n').trim();
  if (!description) return undefined;
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new Error(`Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters`);
  }
  if (BINARY_CONTROL_CHARS.test(description)) throw new Error('Skill description contains control characters');
  return description;
}

function markdownTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return cleanName(match[1]);
  }
  return undefined;
}

function bodyDescription(body: string): string {
  const lines = body.split(/\r?\n/);
  let paragraph: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```|^~~~/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^#{1,6}(?:\s|$)/.test(line)) continue;
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) return '';
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_SKILL_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function parseSkill(text: string, fallbackName: string): ParsedSkill {
  const frontmatter = parseFrontmatter(text);
  const metadataName = cleanName(frontmatter.name);
  const title = metadataName ? undefined : markdownTitle(frontmatter.body);
  const fallback = cleanName(fallbackName);
  const name = metadataName ?? title ?? fallback;
  if (!name) throw new Error('Skill needs a name, Markdown title, or usable file name');
  return {
    name,
    description: cleanDescription(frontmatter.description) ?? bodyDescription(frontmatter.body),
    nameSource: metadataName ? 'frontmatter' : title ? 'title' : 'fallback',
    frontmatter,
  };
}

/** Project/repository discovery is stricter than managed imports: metadata must be explicit. */
export function parseDiscoveredSkillFrontmatter(text: string): { name: string; description: string } {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.exists) throw new Error('Discovered skills require YAML frontmatter with name and description');
  const name = cleanName(frontmatter.name);
  const description = cleanDescription(frontmatter.description);
  if (!name || !description) throw new Error('Discovered skills require YAML frontmatter with name and description');
  return { name, description };
}

function sourceFallbackName(source: string): string {
  const extension = path.extname(source);
  const stem = path.basename(source, extension).trim();
  if (stem.toLowerCase() !== 'skill') return stem || 'skill';
  return path.basename(path.dirname(source)).trim() || 'skill';
}

function stabilizeFallbackName(text: string, parsed: ParsedSkill): string {
  if (parsed.nameSource !== 'fallback') return text;
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const nameLine = `name: ${JSON.stringify(parsed.name)}${eol}`;
  if (parsed.frontmatter.exists && source.startsWith('---')) {
    const firstBreak = source.indexOf('\n');
    if (firstBreak >= 0) return bom + source.slice(0, firstBreak + 1) + nameLine + source.slice(firstBreak + 1);
  }
  return `${bom}---${eol}${nameLine}---${eol}${source}`;
}

async function inspectManagedSkill(id: string): Promise<ManagedSkill> {
  requireSkillId(id);
  const root = await requireRoot();
  const directory = path.join(root.directory, id);
  if (!isContained(root.directory, directory)) throw new Error('Skill path escapes the library');
  let directoryStat: Stats;
  try {
    directoryStat = await fs.lstat(directory);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') throw new Error(`Skill "${id}" was not found`);
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Skill "${id}" directory is unsafe`);
  const directoryReal = await canonicalRealpath(directory);
  if (!isContained(root.directoryReal, directoryReal) || samePath(root.directoryReal, directoryReal)) {
    throw new Error(`Skill "${id}" directory escapes the library`);
  }

  const file = path.join(directory, SKILL_FILE_NAME);
  let fileStat: Stats;
  try {
    fileStat = await fs.lstat(file);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') throw new Error(`Skill "${id}" is missing ${SKILL_FILE_NAME}`);
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Skill "${id}" ${SKILL_FILE_NAME} is unsafe`);
  const fileReal = await canonicalRealpath(file);
  if (!isContained(directoryReal, fileReal) || !isContained(root.directoryReal, fileReal)) {
    throw new Error(`Skill "${id}" ${SKILL_FILE_NAME} escapes the library`);
  }
  return { directory, directoryReal, directoryStat, file, fileStat };
}

export function parseImplicitInvocationPolicy(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let policyIndent = -1;
  let foundPolicy = false;
  let value: boolean | undefined;
  for (const rawLine of lines) {
    const uncommented = stripYamlComment(rawLine).trimEnd();
    if (!uncommented.trim() || uncommented.trim() === '---' || uncommented.trim() === '...') continue;
    const indent = uncommented.match(/^[ \t]*/)?.[0].length ?? 0;
    const trimmed = uncommented.trim();
    if (!foundPolicy) {
      if (/^policy\s*:\s*$/.test(trimmed)) {
        foundPolicy = true;
        policyIndent = indent;
        continue;
      }
      if (/^policy\s*:/.test(trimmed)) throw new Error('Skill policy must be a mapping');
      continue;
    }
    if (indent <= policyIndent) break;
    const match = /^allow_implicit_invocation\s*:\s*(\S+)\s*$/.exec(trimmed);
    if (!match) continue;
    if (value !== undefined) throw new Error('Skill implicit-invocation policy is duplicated');
    if (match[1] === 'true') value = true;
    else if (match[1] === 'false') value = false;
    else throw new Error('Skill allow_implicit_invocation must be true or false');
  }
  return value ?? true;
}

/**
 * Upstream-compatible implicit invocation policy. Missing metadata defaults to true; malformed
 * metadata fails closed for automatic use while explicit /skill selection remains available.
 */
export async function skillImplicitInvocationPolicy(id: string): Promise<{ allow: boolean; error: string | null }> {
  try {
    const managed = await inspectManagedSkill(id);
    const agentsDirectory = path.join(managed.directory, 'agents');
    const metadataFile = path.join(agentsDirectory, 'openai.yaml');
    let directoryStat: Stats;
    try {
      directoryStat = await fs.lstat(agentsDirectory);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return { allow: true, error: null };
      throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Skill agents metadata directory is unsafe');
    const agentsReal = await canonicalRealpath(agentsDirectory);
    if (!isContained(managed.directoryReal, agentsReal) || samePath(managed.directoryReal, agentsReal)) {
      throw new Error('Skill agents metadata directory escapes the skill package');
    }
    let metadataStat: Stats;
    try {
      metadataStat = await fs.lstat(metadataFile);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return { allow: true, error: null };
      throw error;
    }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('Skill interface metadata must be a regular file');
    if (metadataStat.size > MAX_SKILL_INTERFACE_BYTES) throw new Error('Skill interface metadata exceeds 64 KiB');
    const metadataReal = await canonicalRealpath(metadataFile);
    if (!isContained(agentsReal, metadataReal) || !isContained(managed.directoryReal, metadataReal)) {
      throw new Error('Skill interface metadata escapes the skill package');
    }
    const metadata = await readBoundedUtf8(metadataFile, metadataStat);
    return { allow: parseImplicitInvocationPolicy(metadata), error: null };
  } catch (error) {
    return { allow: false, error: errorText(error) };
  }
}

async function readInstalledSkill(id: string): Promise<SkillSummary & { text: string }> {
  const managed = await inspectManagedSkill(id);
  const text = await readBoundedUtf8(managed.file, managed.fileStat);
  const parsed = parseSkill(text, id);
  return { id, name: parsed.name, description: parsed.description, text };
}

export async function readSkill(id: string): Promise<SkillSummary & { text: string }> {
  return readInstalledSkill(id);
}

/** Re-read the directory every time so a model-created SKILL.md appears without app restart. */
export async function listSkills(): Promise<SkillLibrary> {
  const state = library;
  if (!state) throw new Error('Skill library is not initialized');
  const skills: SkillSummary[] = [];
  const rawErrors: string[] = [];
  let omittedErrors = 0;
  const addError = (message: string): void => {
    if (rawErrors.length < MAX_SKILL_ERRORS - 1) rawErrors.push(message);
    else omittedErrors++;
  };

  try {
    await requireRoot();
    const entries: string[] = [];
    let entryCount = 0;
    for await (const entry of await fs.opendir(state.directory)) {
      entryCount++;
      if (entryCount > MAX_SKILL_DIRECTORY_ENTRIES) {
        addError(`Skill directory has more than ${MAX_SKILL_DIRECTORY_ENTRIES} entries; remaining entries were not scanned`);
        break;
      }
      entries.push(entry.name);
    }
    entries.sort((a, b) => a.localeCompare(b));
    let skillLimitReported = false;
    for (const id of entries) {
      if (!isSafeSkillId(id)) {
        addError(`Unsafe or unsupported skill entry "${id}"`);
        continue;
      }
      if (skills.length >= MAX_SKILLS) {
        if (!skillLimitReported) {
          addError(`Skill library contains more than ${MAX_SKILLS} readable skills; remaining skills were not loaded`);
          skillLimitReported = true;
        }
        continue;
      }
      try {
        const skill = await readInstalledSkill(id);
        skills.push({ id: skill.id, name: skill.name, description: skill.description });
      } catch (error) {
        addError(`${id}: ${errorText(error)}`);
      }
    }
  } catch (error) {
    addError(errorText(error));
  }
  if (omittedErrors > 0) rawErrors.push(`${omittedErrors} additional skill errors omitted by the ${MAX_SKILL_ERRORS} error limit`);
  return { directory: state.directory, skills, errors: rawErrors };
}

function queueMutation<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutations.then(work);
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Import one user-selected Markdown/text file. Metadata is parsed as inert text only. */
export function importSkillFile(source: string): Promise<SkillSummary> {
  return queueMutation(async () => {
    if (!path.isAbsolute(source)) throw new Error('Choose an absolute skill file path');
    const extension = path.extname(source).toLowerCase();
    if (extension !== '.md' && extension !== '.txt') throw new Error('Skill import accepts only .md or .txt files');
    const sourceText = await readBoundedUtf8(source);
    const parsed = parseSkill(sourceText, sourceFallbackName(source));
    const id = skillIdFrom(parsed.name);
    const storedText = stabilizeFallbackName(sourceText, parsed);
    if (Buffer.byteLength(storedText, 'utf8') > MAX_SKILL_BYTES) {
      throw new Error(`Normalized skill content exceeds the ${MAX_SKILL_BYTES} byte limit`);
    }

    const root = await requireRoot();
    const targetDirectory = path.join(root.directory, id);
    let createdDirectory = false;
    let createdDirectoryStat: Stats | null = null;
    try {
      try {
        await fs.mkdir(targetDirectory);
        createdDirectory = true;
      } catch (error) {
        if (fsErrorCode(error) === 'EEXIST') throw new Error(`Skill "${id}" already exists`);
        throw error;
      }
      const directoryStat = await fs.lstat(targetDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('New skill directory is unsafe');
      createdDirectoryStat = directoryStat;
      const directoryReal = await canonicalRealpath(targetDirectory);
      if (!isContained(root.directoryReal, directoryReal)) throw new Error('New skill directory escapes the library');
      const targetFile = path.join(targetDirectory, SKILL_FILE_NAME);
      await fs.writeFile(targetFile, storedText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const installed = await readInstalledSkill(id);
      return { id: installed.id, name: installed.name, description: installed.description };
    } catch (error) {
      if (createdDirectory) {
        try {
          const directoryNow = await fs.lstat(targetDirectory);
          if (
            createdDirectoryStat &&
            directoryNow.isDirectory() &&
            !directoryNow.isSymbolicLink() &&
            sameFileIdentity(createdDirectoryStat, directoryNow)
          ) {
            const targetFile = path.join(targetDirectory, SKILL_FILE_NAME);
            try {
              const stat = await fs.lstat(targetFile);
              if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(targetFile);
            } catch (cleanupError) {
              if (fsErrorCode(cleanupError) !== 'ENOENT') {
                // Preserve unexpected contents; rmdir below is intentionally non-recursive.
              }
            }
            try {
              await fs.rmdir(targetDirectory);
            } catch {
              // A concurrent/unexpected supporting file wins over cleanup; never recurse here.
            }
          }
        } catch {
          // If the directory identity changed, leave it alone.
        }
      }
      throw error;
    }
  });
}

/** Remove only SKILL.md, then remove its directory only if nothing else is present. */
export function removeSkill(id: string): Promise<void> {
  return queueMutation(async () => {
    const managed = await inspectManagedSkill(id);
    const [directoryNow, fileNow] = await Promise.all([fs.lstat(managed.directory), fs.lstat(managed.file)]);
    if (
      directoryNow.isSymbolicLink() || !directoryNow.isDirectory() || !sameFileIdentity(managed.directoryStat, directoryNow) ||
      fileNow.isSymbolicLink() || !fileNow.isFile() || !sameFileIdentity(managed.fileStat, fileNow)
    ) throw new Error(`Skill "${id}" changed during removal`);
    await fs.unlink(managed.file);

    const after = await fs.lstat(managed.directory);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(directoryNow, after)) {
      throw new Error(`Skill "${id}" directory changed during removal`);
    }
    try {
      await fs.rmdir(managed.directory);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOTEMPTY' && fsErrorCode(error) !== 'EEXIST') throw error;
    }
  });
}
