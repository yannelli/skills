import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every write Yard makes to a developer's real client configuration goes
 * through here: back the file up, write to a sibling temp file, then rename.
 * A crash mid-write leaves the original intact.
 */

export type WriteOptions = {
  /** Report what would change without touching disk. */
  dryRun?: boolean;
  /** Directory to copy the previous contents into before overwriting. */
  backupDir?: string;
};

export type WriteResult = {
  file: string;
  changed: boolean;
  created: boolean;
  backup?: string;
  /** Populated on a dry run so callers can show a diff. */
  before?: string;
  after: string;
};

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Parse JSON that may carry comments or trailing commas. Claude Code and
 * Cursor both tolerate them in settings files, so a strict parse would reject
 * configuration the client itself accepts.
 */
export function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonComments(raw)) as T;
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const raw = await readText(file);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseJsonc<T>(raw);
  } catch {
    return undefined;
  }
}

/**
 * Like {@link readJson} but reports why a file failed instead of swallowing it,
 * so a corrupt settings file surfaces as a warning rather than as silence.
 */
export async function readJsonChecked<T>(
  file: string
): Promise<{ value?: T; error?: string; missing: boolean }> {
  const raw = await readText(file);
  if (raw === undefined) {
    return { missing: true };
  }
  try {
    return { value: parseJsonc<T>(raw), missing: false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), missing: false };
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function listFiles(dir: string, extensions?: string[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !extensions || extensions.includes(path.extname(name)))
      .sort();
  } catch {
    return [];
  }
}

/** Atomically replace `file` with `contents`, backing up what was there. */
export async function writeTextSafely(
  file: string,
  contents: string,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const before = await readText(file);
  const created = before === undefined;
  const changed = before !== contents;

  if (!changed) {
    return { file, changed: false, created: false, after: contents, ...(before !== undefined ? { before } : {}) };
  }

  if (options.dryRun) {
    return { file, changed: true, created, after: contents, ...(before !== undefined ? { before } : {}) };
  }

  await mkdir(path.dirname(file), { recursive: true });

  let backup: string | undefined;
  if (before !== undefined && options.backupDir) {
    backup = await backupFile(file, options.backupDir);
  }

  const temp = `${file}.yard-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, contents, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  return {
    file,
    changed: true,
    created,
    after: contents,
    ...(before !== undefined ? { before } : {}),
    ...(backup ? { backup } : {})
  };
}

/**
 * Write JSON while preserving the file's existing indentation and trailing
 * newline, so Yard's edits do not show up as whole-file reformats in git.
 */
export async function writeJsonSafely(
  file: string,
  value: unknown,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const raw = await readText(file);
  const indent = raw === undefined ? 2 : detectIndent(raw);
  const trailingNewline = raw === undefined ? true : raw.endsWith('\n');
  const body = JSON.stringify(value, null, indent);
  return writeTextSafely(file, trailingNewline ? `${body}\n` : body, options);
}

async function backupFile(file: string, backupDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `${path.basename(file)}.${stamp}.bak`);
  await mkdir(backupDir, { recursive: true });
  await copyFile(file, target);
  return target;
}

export function detectIndent(raw: string): number {
  const match = /\n([ \t]+)\S/.exec(raw);
  if (!match?.[1]) {
    return 2;
  }
  return match[1].startsWith('\t') ? 1 : match[1].length;
}

/**
 * Remove `//` and block comments without disturbing anything inside a string,
 * and drop trailing commas so JSON.parse accepts the result.
 */
export function stripJsonComments(raw: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] as string;
    const next = raw[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        const escaped = raw[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i += 1;
        }
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}
