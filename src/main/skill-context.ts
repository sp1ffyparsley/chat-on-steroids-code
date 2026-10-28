import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Root } from '../shared/types.js';
import { skillsDirectory } from './skills.js';
import {
  listSkillLibrary,
  skillLibraryInstructions,
  type ScopedSkillLibrary,
  type SkillLibraryScope,
} from './skill-library.js';

/** Only the managed skills directory joins Core's existing filesystem boundary. */
export function withSkillsRoot<T extends { roots: Root[] }>(context: T): T {
  const base = context.roots.some(root => root.name === 'skills')
    ? { ...context, roots: context.roots.filter(root => root.name !== 'skills') } : context;
  const directory = skillsDirectory();
  if (!directory) return base;
  try {
    const stat = lstatSync(directory);
    const canonical = realpathSync.native(directory);
    const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || identity(canonical) !== identity(directory)) return base;
    return { ...base, roots: [...base.roots, { name: 'skills', path: directory }] };
  } catch { return base; }
}

/** Metadata is a directory index; skill bodies are loaded only when selected or read. */
export async function skillIndexInstructions(
  library?: ScopedSkillLibrary,
  scope: SkillLibraryScope = {},
): Promise<string> {
  if (!skillsDirectory()) return '';
  return skillLibraryInstructions(library ?? await listSkillLibrary(scope));
}
