import path from 'node:path';
import { isFile, listDirs } from './safe-io.js';

/**
 * Find a plugin's skill directories.
 *
 * `skills/<name>/SKILL.md` is only the default. A manifest may point `skills`
 * at another directory, or list explicit skill paths, and real plugins group
 * their skills into category folders (`./skills/engineering/tdd`). Scanning one
 * level below `skills/` silently loses all of those.
 */

/** Deep enough for category folders, shallow enough not to walk node_modules. */
const MAX_DEPTH = 4;

const SKIP = new Set(['node_modules', '.git', 'assets', 'scripts', 'templates', 'dist', 'build']);

export async function collectSkillDirs(pluginRoot: string, declared?: unknown): Promise<string[]> {
  const found = new Set<string>();

  await walk(path.join(pluginRoot, 'skills'), 0, found);

  for (const entry of declaredPaths(declared)) {
    const target = path.resolve(pluginRoot, entry);
    // A declared entry is usually a skill directory itself, but the schema also
    // allows pointing at a directory that holds several.
    if (await isFile(path.join(target, 'SKILL.md'))) {
      found.add(target);
      continue;
    }
    await walk(target, 0, found);
  }

  return [...found].sort();
}

function declaredPaths(declared: unknown): string[] {
  if (typeof declared === 'string') {
    return [declared];
  }
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

async function walk(dir: string, depth: number, found: Set<string>): Promise<void> {
  if (depth > MAX_DEPTH) {
    return;
  }
  if (await isFile(path.join(dir, 'SKILL.md'))) {
    found.add(dir);
    // A skill's own bundled resources are not further skills.
    return;
  }
  for (const name of await listDirs(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) {
      continue;
    }
    await walk(path.join(dir, name), depth + 1, found);
  }
}
