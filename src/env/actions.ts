import * as claude from './claude.js';
import * as cursor from './cursor.js';
import { scanEnvironment } from './inventory.js';
import type { Client, Inventory, SkillVisibility } from './types.js';

/**
 * One entry point for every change Yard makes, shared by the CLI, the HTTP API,
 * and the MCP tools.
 *
 * Each client stores the same idea somewhere different — Claude Code has a
 * `skillOverrides` map, Cursor has no enabled flag at all — so the dispatch and
 * the "which client did you mean" resolution live here rather than being
 * reimplemented per surface.
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
  client?: Client;
  scope?: ActionScope;
  dryRun?: boolean;
  /** Pass a scan you already have to avoid rescanning. */
  inventory?: Inventory;
};

export async function setSkillVisibility(
  opts: Common & { skill: string; visibility: SkillVisibility }
): Promise<ActionResult> {
  const client = await resolveClient(opts, `skill "${opts.skill}"`, (inventory) =>
    inventory.skills.filter((skill) => skill.qualifiedName === opts.skill || skill.name === opts.skill)
  );

  if (client !== 'claude') {
    // Only Claude Code has a visibility setting. Codex and Cursor can only
    // enable or disable a skill wholesale, by moving its directory.
    const enabled = opts.visibility === 'on';
    return setSkillEnabled({ ...opts, enabled, client });
  }

  const result = await claude.setSkillVisibility({
    skill: opts.skill,
    visibility: opts.visibility,
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${opts.skill} → ${opts.visibility} in ${result.file}`
      : `${opts.skill} was already ${opts.visibility}`
  };
}

/** Enable or disable a personal skill by moving its directory. */
export async function setSkillEnabled(opts: Common & { skill: string; enabled: boolean }): Promise<ActionResult> {
  const client = await resolveClient(opts, `skill "${opts.skill}"`, (inventory) =>
    inventory.skills.filter((skill) => skill.qualifiedName === opts.skill || skill.name === opts.skill)
  );

  const move =
    client === 'claude'
      ? await claude.setSkillDirectoryEnabled({
          skill: opts.skill,
          enabled: opts.enabled,
          projectRoot: opts.projectRoot,
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
        })
      : client === 'codex'
        ? await (await import('./codex.js')).setSkillDirectoryEnabled({
            skill: opts.skill,
            enabled: opts.enabled,
            ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
          })
        : undefined;

  if (!move) {
    throw new Error(
      `Cursor has no enable/disable for skills. Move ${opts.skill} out of its skills directory by hand.`
    );
  }

  return {
    changed: move.moved,
    file: move.to,
    dryRun: opts.dryRun === true,
    detail: move.moved
      ? `moved ${move.from} → ${move.to}`
      : opts.dryRun
        ? `would move ${move.from} → ${move.to}`
        : `${opts.skill} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

export async function setPluginEnabled(opts: Common & { plugin: string; enabled: boolean }): Promise<ActionResult> {
  const client = await resolveClient(opts, `plugin "${opts.plugin}"`, (inventory) =>
    inventory.plugins.filter((plugin) => plugin.qualifiedName === opts.plugin || plugin.name === opts.plugin)
  );

  if (client !== 'claude') {
    throw new Error(
      `Only Claude Code stores plugin enablement in settings. Use \`${client} plugin ${
        opts.enabled ? 'add' : 'remove'
      } ${opts.plugin}\`.`
    );
  }

  const result = await claude.setPluginEnabled({
    plugin: opts.plugin,
    enabled: opts.enabled,
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${opts.plugin} ${opts.enabled ? 'enabled' : 'disabled'} in ${result.file}`
      : `${opts.plugin} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

export async function setMcpEnabled(opts: Common & { server: string; enabled: boolean }): Promise<ActionResult> {
  const client = await resolveClient(opts, `mcp server "${opts.server}"`, (inventory) =>
    inventory.mcpServers.filter((server) => server.name === opts.server)
  );

  if (client === 'cursor') {
    const result = await cursor.setMcpServerEnabled({
      server: opts.server,
      enabled: opts.enabled,
      scope: opts.scope === 'project' ? 'project' : 'user',
      projectRoot: opts.projectRoot,
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
    });
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
    throw new Error(
      `Codex owns ~/.codex/config.toml. Use \`codex mcp ${opts.enabled ? 'add' : 'remove'} ${opts.server}\` so its formatting and comments survive.`
    );
  }

  const result = await claude.setMcpEnabled({
    server: opts.server,
    enabled: opts.enabled,
    projectRoot: opts.projectRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {})
  });

  return {
    changed: result.changed,
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
    dryRun: opts.dryRun === true,
    detail: result.changed
      ? `${opts.server} ${opts.enabled ? 'approved' : 'rejected'} in ${result.file}`
      : `${opts.server} was already ${opts.enabled ? 'enabled' : 'disabled'}`
  };
}

/**
 * Work out which client a bare name refers to. An explicit `client` narrows the
 * search rather than skipping it — a name that client does not have would
 * otherwise be written into its config as a setting for something that does not
 * exist. A name found in exactly one client is unambiguous; anything else is an
 * error naming the subject and the candidates, because guessing would edit the
 * wrong config.
 */
async function resolveClient(
  opts: Common,
  subject: string,
  matches: (inventory: Inventory) => Array<{ client: Client; id: string }>
): Promise<Client> {
  const inventory = opts.inventory ?? (await scanEnvironment(opts.projectRoot));
  const found = matches(inventory);
  const clients = [...new Set(found.map((item) => item.client))];

  if (opts.client) {
    if (clients.includes(opts.client)) {
      return opts.client;
    }
    throw new Error(
      clients.length
        ? `${subject} not found in ${opts.client} — it is in ${clients.join(', ')}`
        : `${subject} not found in ${opts.client} — run \`yard scan\` to see what is there`
    );
  }

  if (clients.length === 1 && clients[0]) {
    return clients[0];
  }
  if (clients.length === 0) {
    throw new Error(`${subject} not found in any installed client — run \`yard scan\` to see what is there`);
  }
  // Names the option, not one surface's spelling of it: the CLI writes
  // `--client=codex`, the HTTP body writes `"client": "codex"`, and an MCP tool
  // takes a `client` argument. Telling an API caller to "pass --client" sends
  // them looking for a flag their surface does not have.
  throw new Error(
    `${subject} is ambiguous across ${clients.join(', ')} — set client to one of them (matched ${found
      .map((item) => item.id)
      .join(', ')})`
  );
}
