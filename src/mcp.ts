import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Catalog } from './catalog.js';
import { indexOf } from './catalog.js';
import { Embeddings } from './embed.js';
import { searchCatalog } from './search.js';
import type { Session } from './session.js';
import { ARTIFACT_KINDS } from './types.js';

const KindSchema = z.enum(ARTIFACT_KINDS);

export function createYardServer(
  catalog: Catalog,
  session: Session,
  embeddings: Embeddings = Embeddings.none()
): McpServer {
  const server = new McpServer({
    name: 'yard',
    version: '0.1.0'
  });

  server.registerTool(
    'catalog_search',
    {
      title: 'Search catalog',
      description:
        'Search marketplace skills, rules, agents, commands, hooks, and MCP servers. Returns metadata only. Uses OpenRouter embeddings when embeddings search is enabled. In dynamic mode, hydrate an id to load its body and activate that plugin’s hooks and MCP.',
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
      const view = await session.view();
      const semantic =
        view.embeddingsEnabled && embeddings.available()
          ? { embeddings, model: view.embeddingsModel }
          : undefined;
      const { hits, mode } = await searchCatalog(
        artifacts,
        {
          query,
          ...(kinds ? { kinds } : {}),
          ...(plugin ? { plugin } : {}),
          ...(limit !== undefined ? { limit } : {})
        },
        semantic
      );
      return textResult({ hits: hits.map(indexOf), count: hits.length, mode, model: view.embeddingsModel });
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
      description:
        'Dynamic mode, embeddings search, pins, hydrated artifacts, active hooks, live MCP, and the currently available id set.',
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
    'session_set_embeddings',
    {
      title: 'Set embeddings search',
      description:
        'Enable semantic catalog search through OpenRouter. Default model is voyageai/voyage-4-lite. Requires OPENROUTER_API_KEY. Vectors are cached under .yard/embeddings.',
      inputSchema: z.object({
        enabled: z.boolean(),
        model: z.string().optional().describe('OpenRouter embedding model id, e.g. voyageai/voyage-4-lite')
      })
    },
    async ({ enabled, model }) => {
      if (enabled && !embeddings.available()) {
        throw new Error('OPENROUTER_API_KEY is not set');
      }
      return textResult(await session.setEmbeddings({ enabled, ...(model ? { model } : {}) }));
    }
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
