import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { adaptPlugin } from './adapt.js';
import type { Catalog } from './catalog.js';
import { indexOf } from './catalog.js';
import { actionTarget, DEFAULT_ROW_LIMIT, ENV_KINDS, summarizeInventory, toEnvKind } from './env-api.js';
import { setMcpEnabled, setPluginEnabled, setSkillEnabled, setSkillVisibility } from './env/actions.js';
import { buildContextReport } from './env/context.js';
import { diagnose } from './env/doctor.js';
import { scanEnvironment } from './env/inventory.js';
import { formatTokens } from './env/tokens.js';
import { CLIENTS, SKILL_VISIBILITIES } from './env/types.js';
import { searchArtifacts } from './search.js';
import type { Session } from './session.js';
import { ARTIFACT_KINDS } from './types.js';

const KindSchema = z.enum(ARTIFACT_KINDS);

/**
 * The schema advertises the canonical plural vocabulary, which is what a model
 * reading it will send. It also quietly accepts the singular the CLI uses
 * (`--kind=skill`), because a model that has read the docs guessing `skill`
 * should not have to spend a turn learning that this surface pluralises. Same
 * rule the HTTP query parameter follows.
 */
const EnvKindSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (toEnvKind(value) ?? value) : value),
  z.enum(ENV_KINDS)
);
const ClientSchema = z.enum(CLIENTS);
const ScopeSchema = z.enum(['user', 'project', 'local']);
const VisibilitySchema = z.enum(SKILL_VISIBILITIES);

/** Context and doctor reports are as long as the setup is bad; keep them readable. */
const MAX_REPORT_LINES = 25;

export function createYardServer(catalog: Catalog, session: Session): McpServer {
  const server = new McpServer({
    name: 'yard',
    version: '0.1.0'
  });

  server.registerTool(
    'catalog_search',
    {
      title: 'Search catalog',
      description:
        'Search marketplace skills, rules, agents, commands, hooks, and MCP servers. Returns metadata only. In dynamic mode, hydrate an id to load its body and activate that plugin’s hooks and MCP.',
      inputSchema: z.object({
        query: z.string().describe('Free-text query. Empty lists the catalog.'),
        kinds: z.array(KindSchema).optional(),
        plugin: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, kinds, plugin, limit }) => {
      const { artifacts } = await catalog.load();
      const hits = searchArtifacts(artifacts, {
        query,
        ...(kinds ? { kinds } : {}),
        ...(plugin ? { plugin } : {}),
        ...(limit !== undefined ? { limit } : {})
      }).map(indexOf);
      return textResult({ hits, count: hits.length });
    }
  );

  server.registerTool(
    'catalog_get',
    {
      title: 'Get artifact',
      description:
        'Read one artifact. In dynamic mode this fails closed unless the id is pinned or hydrated.',
      inputSchema: z.object({
        id: z.string().describe('plugin/kind/name, e.g. review/skill/review')
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      const artifact = await catalog.artifact(id);
      const available = await session.isAvailable(id);
      if (!available) {
        return textResult({
          available: false,
          artifact: indexOf(artifact),
          hint: 'Dynamic mode is on. Call session_hydrate with this id to load the body and attach hooks.'
        });
      }
      return textResult({ available: true, artifact });
    }
  );

  server.registerTool(
    'session_status',
    {
      title: 'Session status',
      description: 'Dynamic mode, pins, hydrated artifacts, active hooks, live MCP, and the currently available id set.',
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => textResult(await session.view())
  );

  server.registerTool(
    'session_set_dynamic',
    {
      title: 'Set dynamic mode',
      description:
        'When enabled, no skill bodies are in context until they are pinned or hydrated. Search still works. Hydrate returns content and activates that plugin’s hooks and MCP.',
      inputSchema: z.object({
        enabled: z.boolean()
      })
    },
    async ({ enabled }) => textResult(await session.setDynamicMode(enabled))
  );

  server.registerTool(
    'session_hydrate',
    {
      title: 'Hydrate artifacts',
      description:
        'Load artifact bodies into the session and activate that plugin’s hooks and MCP. Use after catalog_search in dynamic mode.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1)
      })
    },
    async ({ ids }) => {
      const view = await session.hydrate(ids);
      const loaded = await Promise.all(ids.map((id) => catalog.artifact(id)));
      return textResult({ session: view, artifacts: loaded });
    }
  );

  server.registerTool(
    'session_dehydrate',
    {
      title: 'Dehydrate artifacts',
      description:
        'Drop hydrated artifacts from the session. Hooks and MCP deactivate when the plugin has nothing left loaded.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1)
      })
    },
    async ({ ids }) => textResult(await session.dehydrate(ids))
  );

  server.registerTool(
    'session_pin',
    {
      title: 'Pin artifacts',
      description: 'Always-available artifacts even when dynamic mode is on. Does not by itself activate hooks.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1)
      })
    },
    async ({ ids }) => textResult(await session.pin(ids))
  );

  server.registerTool(
    'session_unpin',
    {
      title: 'Unpin artifacts',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1)
      })
    },
    async ({ ids }) => textResult(await session.unpin(ids))
  );

  server.registerTool(
    'session_set_mcp',
    {
      title: 'Set MCP live',
      description: 'Mark plugin MCP servers live or idle in this Yard session. Does not write client MCP stores.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1),
        active: z.boolean()
      })
    },
    async ({ ids, active }) => textResult(await session.setMcpLive(ids, active))
  );

  server.registerTool(
    'session_set_plugin',
    {
      title: 'Enable or disable a plugin',
      inputSchema: z.object({
        name: z.string(),
        enabled: z.boolean()
      })
    },
    async ({ name, enabled }) => textResult(await session.setPluginEnabled(name, enabled))
  );

  server.registerTool(
    'plugin_adapt',
    {
      title: 'Adapt a Claude skill or plugin',
      description:
        'Write the missing Codex, Cursor, and Agent Plugins files for a Claude-only skill or plugin. Existing files are left alone. Register only when the destination is plugins/<name>.',
      inputSchema: z.object({
        source: z.string().describe('Path to a SKILL.md file or a Claude plugin directory'),
        name: z.string().optional().describe('Override the kebab-case plugin name'),
        dest: z.string().optional().describe('Destination plugin directory. Defaults to plugins/<name>.'),
        register: z
          .boolean()
          .optional()
          .describe('Add marketplace catalog entries. Defaults to true for a new plugins/<name> directory.')
      })
    },
    async ({ source, name, dest, register }) => {
      const report = await adaptPlugin({
        source,
        ...(name ? { name } : {}),
        ...(dest ? { dest } : {}),
        ...(register !== undefined ? { register } : {})
      });
      catalog.invalidate();
      return textResult(report);
    }
  );

  server.registerTool(
    'catalog_reload',
    {
      title: 'Reload catalog',
      description: 'Rescan marketplace.json and plugin directories.',
      annotations: { readOnlyHint: true }
    },
    async () => {
      catalog.invalidate();
      const snap = await catalog.load();
      return textResult({ plugins: snap.plugins.length, artifacts: snap.artifacts.length });
    }
  );

  server.registerTool(
    'env_inventory',
    {
      title: 'List the installed agent environment',
      description:
        'What Claude Code, Codex, and Cursor will actually load here: skills, plugins, MCP servers, hooks, subagents, commands, and memory files. Use it when the user asks what is installed, why something is or is not available, or before changing any client config. Returns counts for every kind plus at most `limit` rows, so pass `kind` to see one kind in full. Reads config files only.',
      inputSchema: z.object({
        client: ClientSchema.optional().describe('Restrict the scan to one client. Defaults to every installed client.'),
        kind: EnvKindSchema.optional().describe('Restrict the rows to one kind. Counts always cover every kind.'),
        limit: z.number().int().min(1).max(200).optional().describe(`Rows to return. Defaults to ${DEFAULT_ROW_LIMIT}.`)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ client, kind, limit }) => {
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      return textResult(
        summarizeInventory(inventory, {
          ...(kind ? { kind } : {}),
          ...(limit !== undefined ? { limit } : {})
        })
      );
    }
  );

  server.registerTool(
    'env_context',
    {
      title: 'Price the context window',
      description:
        'Estimated tokens every turn spends on skill listings, MCP tool schemas, subagents, commands, and memory files, with the biggest offenders and the command that turns each one off. Use it when the user asks why context is tight or what their setup costs. Nothing is written. With probe true it starts the user’s configured MCP servers to read their real tool schemas, which runs those commands — leave it off unless the user asked for exact MCP numbers.',
      inputSchema: z.object({
        client: ClientSchema.optional().describe('Price one client only. Defaults to every installed client.'),
        probe: z
          .boolean()
          .optional()
          .describe('Start each configured MCP server to measure it instead of estimating. Defaults to false.')
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ client, probe }) => {
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      const report = await buildContextReport(inventory, { probe: probe === true });
      const lines = report.lines.slice(0, MAX_REPORT_LINES);
      return textResult({
        projectRoot: report.projectRoot,
        clients: report.clients,
        total: report.total,
        totalHuman: formatTokens(report.total),
        byKind: report.byKind,
        byClient: report.byClient,
        probed: report.probed,
        notes: report.notes,
        lines,
        omitted: report.lines.length - lines.length
      });
    }
  );

  server.registerTool(
    'env_doctor',
    {
      title: 'Diagnose the agent setup',
      description:
        'Find what is quietly broken: hooks pointing at deleted scripts, skills the model can never see, duplicate skill names, plugins that are enabled but not installed, unparseable config. Use it when a skill, hook, or MCP server does not behave as the user expects. Nothing is written. With probe true it starts the user’s configured MCP servers to find out which ones actually come up, which runs those commands — leave it off unless the user asked.',
      inputSchema: z.object({
        client: ClientSchema.optional().describe('Diagnose one client only. Defaults to every installed client.'),
        probe: z.boolean().optional().describe('Start each configured MCP server to check it responds. Defaults to false.')
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ client, probe }) => {
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      const diagnoses = await diagnose(inventory, { probe: probe === true });
      const shown = diagnoses.slice(0, MAX_REPORT_LINES);
      return textResult({
        counts: {
          error: diagnoses.filter((item) => item.severity === 'error').length,
          warning: diagnoses.filter((item) => item.severity === 'warning').length,
          info: diagnoses.filter((item) => item.severity === 'info').length
        },
        probed: probe === true,
        diagnoses: shown,
        omitted: diagnoses.length - shown.length
      });
    }
  );

  server.registerTool(
    'env_set_skill',
    {
      title: 'Set a skill visibility or enablement',
      description:
        'Rewrite the user’s real client config to change how a skill is exposed. `visibility` is Claude Code’s setting: on, name-only (the model sees the name but not the description), user-invocable-only (only a slash command reaches it), or off. `enabled` instead moves the skill directory in or out of the client’s skills folder, which is all Codex offers. Pass dryRun to see the file that would change without touching it.',
      inputSchema: z.object({
        skill: z.string().describe('Skill name, or plugin:name for a plugin skill'),
        visibility: VisibilitySchema.optional(),
        enabled: z.boolean().optional().describe('Move the skill directory instead of setting a visibility'),
        client: ClientSchema.optional().describe('Required only when the name exists in more than one client'),
        scope: ScopeSchema.optional().describe('Which settings file to write. Defaults to user.'),
        dryRun: z.boolean().optional()
      })
    },
    async ({ skill, visibility, enabled, client, scope, dryRun }) => {
      const target = actionTarget({
        ...(client ? { client } : {}),
        ...(scope ? { scope } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      if (visibility !== undefined && enabled !== undefined) {
        throw new Error('pass visibility or enabled, not both');
      }
      if (visibility !== undefined) {
        return textResult(await setSkillVisibility({ ...target, skill, visibility }));
      }
      if (enabled !== undefined) {
        return textResult(await setSkillEnabled({ ...target, skill, enabled }));
      }
      throw new Error('visibility or enabled is required');
    }
  );

  server.registerTool(
    'env_set_plugin',
    {
      title: 'Enable or disable an installed plugin',
      description:
        'Rewrite the user’s real Claude Code settings to turn an installed plugin on or off, which also turns off the skills, hooks, and MCP servers it brings. Pass dryRun to see the file that would change without touching it.',
      inputSchema: z.object({
        plugin: z.string().describe('Plugin name, or name@marketplace'),
        enabled: z.boolean(),
        client: ClientSchema.optional().describe('Required only when the name exists in more than one client'),
        scope: ScopeSchema.optional().describe('Which settings file to write. Defaults to user.'),
        dryRun: z.boolean().optional()
      })
    },
    async ({ plugin, enabled, client, scope, dryRun }) => {
      const target = actionTarget({
        ...(client ? { client } : {}),
        ...(scope ? { scope } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      return textResult(await setPluginEnabled({ ...target, plugin, enabled }));
    }
  );

  server.registerTool(
    'env_set_mcp',
    {
      title: 'Enable or disable an MCP server',
      description:
        'Rewrite the user’s real client config so a configured MCP server is loaded or not. This is the biggest single lever on context cost — an MCP server pays for every tool schema on every turn, whether or not it is used. Pass dryRun to see the file that would change without touching it.',
      inputSchema: z.object({
        server: z.string().describe('Server name as it appears in the client config'),
        enabled: z.boolean(),
        client: ClientSchema.optional().describe('Required only when the name exists in more than one client'),
        scope: ScopeSchema.optional().describe('Which config file to write. Defaults to user.'),
        dryRun: z.boolean().optional()
      })
    },
    async ({ server: name, enabled, client, scope, dryRun }) => {
      const target = actionTarget({
        ...(client ? { client } : {}),
        ...(scope ? { scope } : {}),
        ...(dryRun !== undefined ? { dryRun } : {})
      });
      return textResult(await setMcpEnabled({ ...target, server: name, enabled }));
    }
  );

  server.registerResource(
    'session',
    'yard://session',
    {
      title: 'Yard session',
      description: 'Dynamic mode and the currently available artifact set',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await session.view(), null, 2) }]
    })
  );

  server.registerResource(
    'catalog',
    'yard://catalog',
    {
      title: 'Yard catalog',
      description: 'Metadata index of every artifact. Bodies stay behind catalog_get / session_hydrate.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const { plugins, artifacts } = await catalog.load();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ plugins, artifacts: artifacts.map(indexOf) }, null, 2)
          }
        ]
      };
    }
  );

  server.registerResource(
    'artifact',
    new ResourceTemplate('yard://artifact/{id}', { list: undefined }),
    {
      title: 'Artifact body',
      description: 'Readable only when the artifact is available in the current session',
      mimeType: 'text/plain'
    },
    async (uri, { id }) => {
      const artifactId = String(id);
      const available = await session.isAvailable(artifactId);
      if (!available) {
        throw new Error(`${artifactId} is not in session. Search, then session_hydrate.`);
      }
      const artifact = await catalog.artifact(artifactId);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: artifact.raw }]
      };
    }
  );

  return server;
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
