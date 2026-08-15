import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findMarketplaceRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function resolveRepoRoot(): string {
  if (process.env.YARD_ROOT) {
    return path.resolve(process.env.YARD_ROOT);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const fromProject = findMarketplaceRoot(projectDir);
    if (fromProject) {
      return fromProject;
    }
  }
  return findMarketplaceRoot(process.cwd()) ?? findMarketplaceRoot(HERE) ?? process.cwd();
}

function resolvePublicDir(root: string): string {
  const yardPublic = path.join(root, 'plugins', 'yard', 'public');
  if (existsSync(path.join(yardPublic, 'index.html'))) {
    return yardPublic;
  }
  const beside = path.resolve(HERE, '..', 'public');
  if (existsSync(path.join(beside, 'index.html'))) {
    return beside;
  }
  return path.join(root, 'public');
}

export const REPO_ROOT = resolveRepoRoot();
export const SERVER_DIR = path.resolve(HERE, '..');

export const CLAUDE_MARKETPLACE = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
export const CODEX_MARKETPLACE = path.join(REPO_ROOT, '.agents', 'plugins', 'marketplace.json');
export const CURSOR_MARKETPLACE = path.join(REPO_ROOT, '.cursor-plugin', 'marketplace.json');
export const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'plugin');
export const PUBLIC_DIR = resolvePublicDir(REPO_ROOT);
export const YARD_DIR = path.join(REPO_ROOT, '.yard');
export const SESSION_FILE = path.join(YARD_DIR, 'state.json');
export const YARD_PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'yard');

export const MARKETPLACE_FILES = [CLAUDE_MARKETPLACE, CODEX_MARKETPLACE, CURSOR_MARKETPLACE] as const;
