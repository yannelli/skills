import * as claude from './claude.js';
import * as cursor from './cursor.js';
import { scanEnvironment } from './inventory.js';
import type { Client, Inventory, McpEntry, PluginEntry, Scope, SkillEntry, SkillVisibility } from './types.js';

/**
 * One entry point for every change Yard makes, shared by the CLI, the HTTP API,
 * and the MCP tools.
 *
 * Each client stores the same idea somewhere different — Claude Code has a
 * `skillOverrides` map, Cursor has no enabled flag at all — so the dispatch and
 * the "which client did you mean" resolution live here rather than being
 * reimplemented per surface.
 *
 * Every action resolves to one concrete inventory row before it writes
 * anything, and that row's `scope`/`plugin` — not the bare name it was asked
 * for — decides which native setting is safe to touch. A plugin's skill, its
 * MCP servers, and (for Cursor and Codex) the plugin itself are switched by
 * enabling or disabling the plugin as a whole; there is no client-side lever
 * for "on for the plugin, off for one of its skills" that Yard can write to.
 * Reaching for the standalone lever anyway is exactly how a request came back
 * `changed: true` against a setting the target client never reads. Once a
 * write does go through, a fresh, independent rescan confirms the row it
 * targeted actually reached the requested state before the call reports
 * success — a completed file write is not by itself proof that the client
 * this row belongs to will honour it.
 */

export type ActionResult = {
  changed: boolean;
  /** The file that was written, or would be on a real run. */
  file?: string;
  backup?: string;
  dryRun: boolean;
  /** One line, suitable for printing. */
  detail: string;
};

export type ActionScope = 'user' | 'project' | 'local';

type Common = {
  projectRoot: string;
  /** The stable id a scan hands back on every row. Unambiguous by construction. */
  id?: string;
  client?: Client;
  scope?: ActionScope;
  dryRun?: boolean;
  /** Pass a scan you already have to avoid rescanning. */
  inventory?: Inventory;
};

/**
 * The client/origin action matrix, as a value rather than as scattered
 * conditionals: given one inventory row, is there any native setting Yard
 * can safely write, and if not, why not. `set*` below throw exactly these
 * strings; {@link import('./context.js').buildContextReport} reuses the same
 * predicates so a "turn this off" button is never offered where the write
 * would be refused.
 *
 * A plugin skill has no per-skill switch in *any* client — Claude Code's own
 * settings reference excludes plugin skills from `skillOverrides` by name,
 * and Codex/Cursor have no comparable setting for one skill inside an
 * installed plugin — so the only lever is the plugin's own enable/disable.
 */
export function skillActionBlocked(entry: Pick<SkillEntry, 'client' | 'scope' | 'plugin'>): string | undefined {
  if (entry.scope === 'plugin') {
    return `plugin skill — enable or disable the "${entry.plugin}" plugin instead of switching it alone`;
  }
  if (entry.client === 'cursor') {
    return 'cursor has no skill visibility setting — move the directory by hand';
  }
  return undefined;
}

/** Only Claude Code stores plugin enablement in settings; Codex and Cursor treat install as enable. */
export function pluginActionBlocked(entry: Pick<PluginEntry, 'client'>): string | undefined {
  if (entry.client !== 'claude') {
    return `only Claude Code stores plugin enablement in settings — use \`${entry.client} plugin add/remove\` instead`;
  }
  return undefined;
}

/**
 * Codex owns `~/.codex/config.toml` outright, for every server regardless of
 * origin. Cursor and Claude both have a general per-server switch, but a
 * plugin's own server is one more step removed for Cursor — which has no
 * lever at all for a plugin's contributed servers — while Claude Code's
 * `disabledMcpServers` array in `~/.claude.json` covers plugin servers too.
 */
export function mcpActionBlocked(entry: Pick<McpEntry, 'client' | 'scope' | 'plugin'>): string | undefined {
  if (entry.scope === 'plugin') {
    if (entry.client === 'cursor') {
      return `plugin-contributed MCP server — Cursor manages it through the "${entry.plugin}" plugin, not ~/.cursor/mcp.json`;
    }
    if (entry.client === 'codex') {
      return `plugin-contributed MCP server, not a ~/.codex/config.toml entry — enable or disable the "${entry.plugin}" plugin instead`;
    }
    return undefined;
  }
  if (entry.client === 'codex') {
    return 'codex owns config.toml — use `codex mcp add/remove` so its formatting survives';
  }
  return undefined;
}

export async function setSkillVisibility(
  opts: Common & { skill: string; visibility: SkillVisibility }
): Promise<ActionResult> {
  const { entry, inventory } = await resolveEntry(
    opts,
    `skill "${opts.skill}"`,
    (inv) => inv.skills,
    (skill) => skill.qualifiedName === opts.skill || skill.name === opts.skill
  );
  const client = entry.client;

  if (client !== 'claude') {
    // Only Claude Code has a visibility setting. Codex and Cursor can only
    // enable or disable a skill wholesale, by moving its directory.
    const enabled = opts.visibility === 'on';
    return setSkillEnabled({ ...opts, id: entry.id, enabled, client, inventory });
  }

  if (skillActionBlocked(entry)) {
    // Verified against Claude Code's own settings reference: skillOverrides
    // "does not apply to plugin skills, which are managed through /plugin".
    // Writing one anyway is exactly the false-success case this layer exists
    // to prevent. (Client is always 'claude' here, so the only reason
    // `skillActionBlocked` can return non-undefined is `scope === 'plugin'`.)
    throw new Error(
      `"${entry.qualifiedName}" is a plugin skill; Claude Code does not apply skillOverrides to plugin skills — enable or disable the "${entry.plugin}" plugin instead`
    );
  }

  const result = await claude.setSkillVisibility({
    skill: entry.qualifiedName,
    visibility: opts.visibility,
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  if (opts.dryRun !== true) {
    await verifySkillVisibility(opts.projectRoot, entry.id, opts.visibility);
  }

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${entry.qualifiedName} → ${opts.visibility} in ${result.file}`
      : `${entry.qualifiedName} was already ${opts.visibility}`
  };
}

/** Enable or disable a personal skill by moving its directory. */
export async function setSkillEnabled(opts: Common & { skill: string; enabled: boolean }): Promise<ActionResult> {
  const { entry } = await resolveEntry(
    opts,
    `skill "${opts.skill}"`,
    (inv) => inv.skills,
    (skill) => skill.qualifiedName === opts.skill || skill.name === opts.skill
  );
  const client = entry.client;

  if (entry.scope === 'plugin') {
    throw new Error(
      `"${entry.qualifiedName}" is a plugin skill; ${client} has no per-skill switch for it — enable or disable the "${entry.plugin}" plugin instead`
    );
  }

  const move =
    client === 'claude'
      ? await claude.setSkillDirectoryEnabled({
          skill: entry.qualifiedName,
          enabled: opts.enabled,
          projectRoot: opts.projectRoot,
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
        })
      : client === 'codex'
        ? await (await import('./codex.js')).setSkillDirectoryEnabled({
            skill: entry.qualifiedName,
            enabled: opts.enabled,
            ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
          })
        : undefined;

  if (!move) {
    // Only reachable when `client` is 'cursor': the ternary above already
    // covers 'claude' and 'codex', so `skillActionBlocked` always has a
    // reason by the time we get here.
    throw new Error(`"${entry.qualifiedName}": ${skillActionBlocked(entry) ?? 'no enable/disable lever for this client'}`);
  }

  if (opts.dryRun !== true) {
    await verifySkillEnabled(opts.projectRoot, entry.id, opts.enabled);
  }

  return {
    changed: move.moved,
    file: move.to,
    dryRun: opts.dryRun === true,
    detail: move.moved
      ? `moved ${move.from} → ${move.to}`
      : opts.dryRun
        ? `would move ${move.from} → ${move.to}`
        : `${entry.qualifiedName} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

export async function setPluginEnabled(opts: Common & { plugin: string; enabled: boolean }): Promise<ActionResult> {
  const { entry } = await resolveEntry(
    opts,
    `plugin "${opts.plugin}"`,
    (inv) => inv.plugins,
    (plugin) => plugin.qualifiedName === opts.plugin || plugin.name === opts.plugin
  );
  const client = entry.client;

  if (pluginActionBlocked(entry)) {
    throw new Error(
      `Only Claude Code stores plugin enablement in settings. Use \`${client} plugin ${
        opts.enabled ? 'add' : 'remove'
      } ${entry.qualifiedName}\`.`
    );
  }

  const result = await claude.setPluginEnabled({
    plugin: entry.qualifiedName,
    enabled: opts.enabled,
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  if (opts.dryRun !== true) {
    await verifyPluginEnabled(opts.projectRoot, entry.id, opts.enabled);
  }

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${entry.qualifiedName} ${opts.enabled ? 'enabled' : 'disabled'} in ${result.file}`
      : `${entry.qualifiedName} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

export async function setMcpEnabled(opts: Common & { server: string; enabled: boolean }): Promise<ActionResult> {
  const { entry } = await resolveEntry(
    opts,
    `mcp server "${opts.server}"`,
    (inv) => inv.mcpServers,
    (server) => server.name === opts.server
  );
  const client = entry.client;

  if (client === 'cursor') {
    if (mcpActionBlocked(entry)) {
      throw new Error(
        `"${entry.name}" is a plugin-contributed MCP server; Cursor manages plugin servers through the plugin itself, not ~/.cursor/mcp.json — ${
          opts.enabled ? 'enable' : 'disable'
        } the "${entry.plugin}" plugin instead`
      );
    }
    const result = await cursor.setMcpServerEnabled({
      server: opts.server,
      enabled: opts.enabled,
      scope: entry.scope === 'project' ? 'project' : 'user',
      projectRoot: opts.projectRoot,
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
    });

    if (opts.dryRun !== true) {
      await verifyMcpEnabled(opts.projectRoot, entry.id, opts.enabled);
    }

    return {
      changed: result.changed,
      file: result.file,
      ...(result.backup ? { backup: result.backup } : {}),
      dryRun: opts.dryRun === true,
      detail: result.changed
        ? `${opts.server} ${opts.enabled ? 'restored to' : 'parked out of'} mcpServers in ${result.file}`
        : `${opts.server} was already ${opts.enabled ? 'enabled' : 'disabled'}`
    };
  }

  if (client === 'codex') {
    // Codex owns ~/.codex/config.toml outright, so `mcpActionBlocked` returns
    // a reason for every codex entry regardless of scope — this always
    // throws, just with a scope-specific message.
    if (entry.scope === 'plugin') {
      throw new Error(
        `"${entry.name}" is a plugin-contributed MCP server, not a ~/.codex/config.toml entry — \`codex mcp remove\` would report no such server. ${
          opts.enabled ? 'Enable' : 'Disable'
        } the "${entry.plugin}" plugin instead.`
      );
    }
    throw new Error(
      `Codex owns ~/.codex/config.toml. Use \`codex mcp ${opts.enabled ? 'add' : 'remove'} ${opts.server}\` so its formatting and comments survive.`
    );
  }

  const result = await claude.setMcpEnabled({
    server: opts.server,
    enabled: opts.enabled,
    origin: entry.scope,
    ...(entry.plugin ? { plugin: entry.plugin } : {}),
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  if (opts.dryRun !== true) {
    await verifyMcpEnabled(opts.projectRoot, entry.id, opts.enabled);
  }

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${opts.server} ${describeMcpChange(entry.scope, opts.enabled)} in ${result.file}`
      : `${opts.server} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

/** `.mcp.json` servers go through an approve/reject flow; every other origin is a plain switch. */
function describeMcpChange(scope: Scope, enabled: boolean): string {
  if (scope === 'project') {
    return enabled ? 'approved' : 'rejected';
  }
  return enabled ? 'enabled' : 'disabled';
}

/**
 * Rescans from scratch — never the caller's possibly-stale `opts.inventory` —
 * and confirms the row a write targeted actually reports the requested state.
 * A mismatch means the write landed somewhere the owning client does not
 * read, which is a defect worth surfacing as an error rather than as success.
 */
async function verifySkillVisibility(projectRoot: string, id: string, visibility: SkillVisibility): Promise<void> {
  const rescanned = await scanEnvironment(projectRoot);
  const entry = rescanned.skills.find((skill) => skill.id === id);
  if (entry?.visibility !== visibility) {
    throw new Error(
      `wrote the setting, but rescanning found "${id}" ${
        entry ? `still ${entry.visibility}` : 'gone entirely'
      } instead of ${visibility} — the target client likely does not read that setting for this skill`
    );
  }
}

async function verifySkillEnabled(projectRoot: string, id: string, enabled: boolean): Promise<void> {
  const rescanned = await scanEnvironment(projectRoot);
  const entry = rescanned.skills.find((skill) => skill.id === id);
  const isEnabled = entry !== undefined && entry.visibility !== 'off';
  if (isEnabled !== enabled) {
    throw new Error(
      `moved the directory, but rescanning found "${id}" still ${isEnabled ? 'enabled' : 'disabled'} — check for a duplicate elsewhere on the skill path`
    );
  }
}

async function verifyPluginEnabled(projectRoot: string, id: string, enabled: boolean): Promise<void> {
  const rescanned = await scanEnvironment(projectRoot);
  const entry = rescanned.plugins.find((plugin) => plugin.id === id);
  if ((entry?.enabled ?? false) !== enabled) {
    throw new Error(
      `wrote the setting, but rescanning found "${id}" still ${entry?.enabled ? 'enabled' : 'disabled'} — another settings layer may be overriding it`
    );
  }
}

async function verifyMcpEnabled(projectRoot: string, id: string, enabled: boolean): Promise<void> {
  const rescanned = await scanEnvironment(projectRoot);
  const entry = rescanned.mcpServers.find((server) => server.id === id);
  if ((entry?.enabled ?? false) !== enabled) {
    throw new Error(
      `wrote the setting, but rescanning found "${id}" still ${entry?.enabled ? 'enabled' : 'disabled'} — the target client likely reads a different setting for this server`
    );
  }
}

/**
 * Resolve one inventory row, either by its stable `id` or, for callers with
 * no id to pass (the CLI, MCP tools), by name.
 *
 * An `id` is unambiguous by construction — it is prefixed with the client and
 * carries the row's scope — so it is looked up directly with no further
 * disambiguation. Name-based resolution has to guess: a bare name can match
 * the same client's personal and plugin copies, or the same name in more than
 * one installed client, and guessing wrong means writing into the wrong
 * config. Anything other than exactly one match is refused, naming the
 * candidates, rather than picking one.
 */
async function resolveEntry<T extends { client: Client; id: string }>(
  opts: Common,
  subject: string,
  entriesOf: (inventory: Inventory) => T[],
  matchesName: (entry: T) => boolean
): Promise<{ entry: T; inventory: Inventory }> {
  const inventory = opts.inventory ?? (await scanEnvironment(opts.projectRoot));
  const entries = entriesOf(inventory);

  if (opts.id !== undefined) {
    const entry = entries.find((item) => item.id === opts.id);
    if (!entry) {
      throw new Error(`${subject} — no item with id "${opts.id}"; run \`yard scan\` to see current ids`);
    }
    if (opts.client && entry.client !== opts.client) {
      throw new Error(`id "${opts.id}" belongs to ${entry.client}, not ${opts.client}`);
    }
    return { entry, inventory };
  }

  const found = entries.filter(matchesName);
  const clients = [...new Set(found.map((item) => item.client))];
  const scoped = opts.client ? found.filter((item) => item.client === opts.client) : found;

  if (scoped.length === 1 && scoped[0]) {
    return { entry: scoped[0], inventory };
  }

  if (opts.client) {
    if (scoped.length > 1) {
      throw new Error(
        `${subject} is ambiguous within ${opts.client} (matched ${scoped.map((item) => item.id).join(', ')}) — pass its id instead`
      );
    }
    throw new Error(
      clients.length
        ? `${subject} not found in ${opts.client} — it is in ${clients.join(', ')}`
        : `${subject} not found in ${opts.client} — run \`yard scan\` to see what is there`
    );
  }

  if (found.length === 0) {
    throw new Error(`${subject} not found in any installed client — run \`yard scan\` to see what is there`);
  }
  // Names the option, not one surface's spelling of it: the CLI writes
  // `--client=codex`, the HTTP body writes `"client": "codex"`, and an MCP tool
  // takes a `client` argument. Telling an API caller to "pass --client" sends
  // them looking for a flag their surface does not have.
  throw new Error(
    `${subject} is ambiguous across ${clients.join(', ')} — set client to one of them, or pass its id (matched ${found
      .map((item) => item.id)
      .join(', ')})`
  );
}
