import { homedir } from 'node:os';
import path from 'node:path';
import type { Client } from './types.js';

/**
 * Every on-disk location Yard reads or writes, per client.
 *
 * These were verified against live Claude Code, Codex, and Cursor installs
 * rather than taken from documentation. `YARD_HOME` overrides the home
 * directory so the whole layer can be pointed at a fixture tree in tests.
 */

export function home(): string {
  return process.env.YARD_HOME ? path.resolve(process.env.YARD_HOME) : homedir();
}

export type ClaudePaths = ReturnType<typeof claudePaths>;

export function claudePaths(projectRoot: string) {
  const h = home();
  const dir = path.join(h, '.claude');
  const project = path.join(projectRoot, '.claude');
  return {
    dir,
    /** Global, non-settings config: numStartups, enableAllProjectMcpServers, ... */
    globalConfig: path.join(h, '.claude.json'),
    userSettings: path.join(dir, 'settings.json'),
    userLocalSettings: path.join(dir, 'settings.local.json'),
    projectSettings: path.join(project, 'settings.json'),
    projectLocalSettings: path.join(project, 'settings.local.json'),
    managedSettings: managedClaudeSettings(),
    userSkills: path.join(dir, 'skills'),
    userSkillsDisabled: path.join(dir, 'skills.disabled'),
    projectSkills: path.join(project, 'skills'),
    userAgents: path.join(dir, 'agents'),
    projectAgents: path.join(project, 'agents'),
    userCommands: path.join(dir, 'commands'),
    projectCommands: path.join(project, 'commands'),
    userRules: path.join(dir, 'rules'),
    userMemory: path.join(dir, 'CLAUDE.md'),
    projectMemory: path.join(projectRoot, 'CLAUDE.md'),
    projectMcp: path.join(projectRoot, '.mcp.json'),
    pluginsDir: path.join(dir, 'plugins'),
    knownMarketplaces: path.join(dir, 'plugins', 'known_marketplaces.json'),
    installedPlugins: path.join(dir, 'plugins', 'installed_plugins.json'),
    marketplacesDir: path.join(dir, 'plugins', 'marketplaces'),
    pluginCacheDir: path.join(dir, 'plugins', 'cache')
  };
}

function managedClaudeSettings(): string {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    return path.join('C:\\', 'ProgramData', 'ClaudeCode', 'managed-settings.json');
  }
  return '/etc/claude-code/managed-settings.json';
}

export type CodexPaths = ReturnType<typeof codexPaths>;

export function codexPaths(projectRoot: string) {
  const dir = path.join(home(), '.codex');
  return {
    dir,
    config: path.join(dir, 'config.toml'),
    hooks: path.join(dir, 'hooks.json'),
    userSkills: path.join(dir, 'skills'),
    userSkillsDisabled: path.join(dir, 'skills.disabled'),
    pluginsDir: path.join(dir, 'plugins'),
    pluginCacheDir: path.join(dir, 'plugins', 'cache'),
    userMemory: path.join(dir, 'AGENTS.md'),
    projectMemory: path.join(projectRoot, 'AGENTS.md')
  };
}

export type CursorPaths = ReturnType<typeof cursorPaths>;

export function cursorPaths(projectRoot: string) {
  const dir = path.join(home(), '.cursor');
  const project = path.join(projectRoot, '.cursor');
  return {
    dir,
    cliConfig: path.join(dir, 'cli-config.json'),
    userMcp: path.join(dir, 'mcp.json'),
    projectMcp: path.join(project, 'mcp.json'),
    userHooks: path.join(dir, 'hooks.json'),
    projectHooks: path.join(project, 'hooks.json'),
    userSkills: path.join(dir, 'skills'),
    projectSkills: path.join(project, 'skills'),
    /** Cursor's own bundled skills. Reserved — never write here. */
    builtinSkills: path.join(dir, 'skills-cursor'),
    userRules: path.join(dir, 'rules'),
    projectRules: path.join(project, 'rules'),
    userCommands: path.join(dir, 'commands'),
    projectCommands: path.join(project, 'commands'),
    pluginCacheDir: path.join(dir, 'plugins', 'cache'),
    legacyRules: path.join(projectRoot, '.cursorrules')
  };
}

/** The directory whose presence means the client is installed for this user. */
export function clientHomeDir(client: Client): string {
  switch (client) {
    case 'claude':
      return path.join(home(), '.claude');
    case 'codex':
      return path.join(home(), '.codex');
    case 'cursor':
      return path.join(home(), '.cursor');
    default: {
      const exhaustive: never = client;
      throw new Error(`unknown client: ${String(exhaustive)}`);
    }
  }
}

/** Where Yard keeps backups of files it rewrites. */
export function backupDir(): string {
  return path.join(home(), '.yard', 'backups');
}
