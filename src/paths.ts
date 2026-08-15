import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CLAUDE_MARKETPLACE = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
export const CODEX_MARKETPLACE = path.join(REPO_ROOT, '.agents', 'plugins', 'marketplace.json');
export const CURSOR_MARKETPLACE = path.join(REPO_ROOT, '.cursor-plugin', 'marketplace.json');
export const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'plugin');
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
export const YARD_DIR = path.join(REPO_ROOT, '.yard');
export const SESSION_FILE = path.join(YARD_DIR, 'state.json');

export const MARKETPLACE_FILES = [CLAUDE_MARKETPLACE, CODEX_MARKETPLACE, CURSOR_MARKETPLACE] as const;
