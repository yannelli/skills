import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { assertInsideRoot, indexOf, type Catalog } from './catalog.js';
import { Embeddings } from './embed.js';
import { createYardServer } from './mcp.js';
import { PUBLIC_DIR } from './paths.js';
import { createPlugin } from './scaffold.js';
import { searchCatalog } from './search.js';
import type { Session } from './session.js';
import { ARTIFACT_KINDS, type ArtifactKind } from './types.js';

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export function createYardApp(catalog: Catalog, session: Session, embeddings: Embeddings = Embeddings.none()) {
  const mcp = createMcpHandler(() => createYardServer(catalog, session, embeddings));
  const app = new Hono();
  app.use('*', localhostHostValidation());
  app.use('*', localhostOriginValidation());

  app.get('/api/health', async (c) => {
    const view = await session.view();
    const embeddingsStatus = await embeddings.status(view.embeddingsModel);
    return c.json({
      ok: true,
      name: 'yard',
      embeddings: { ...embeddingsStatus, enabled: view.embeddingsEnabled }
    });
  });

  app.get('/api/embeddings', async (c) => {
    const view = await session.view();
    const embeddingsStatus = await embeddings.status(view.embeddingsModel);
    return c.json({ ...embeddingsStatus, enabled: view.embeddingsEnabled });
  });

  app.post('/api/session/embeddings', async (c) => {
    const body = await c.req.json<{ enabled?: boolean; model?: string }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled is required' }, 400);
    }
    if (body.enabled && !embeddings.available()) {
      return c.json({ error: 'OPENROUTER_API_KEY is not set' }, 400);
    }
    return c.json(await session.setEmbeddings({ enabled: body.enabled, ...(body.model ? { model: body.model } : {}) }));
  });

  app.post('/api/embeddings/reindex', async (c) => {
    if (!embeddings.available()) {
      return c.json({ error: 'OPENROUTER_API_KEY is not set' }, 400);
    }
    const view = await session.view();
    const snap = await catalog.load();
    return c.json(await embeddings.reindex(snap.artifacts, view.embeddingsModel));
  });

  app.get('/api/catalog', async (c) => {
    const snap = await catalog.load();
    const view = await session.view();
    const query = c.req.query('q') ?? '';
    const kind = c.req.query('kind');
    const plugin = c.req.query('plugin');
    const kinds = kind && isKind(kind) ? [kind] : undefined;
    const semantic =
      view.embeddingsEnabled && embeddings.available()
        ? { embeddings, model: view.embeddingsModel }
        : undefined;
    const { hits, mode } = await searchCatalog(
      snap.artifacts,
      {
        query,
        ...(kinds ? { kinds } : {}),
        ...(plugin ? { plugin } : {}),
        limit: 100
      },
      semantic
    );
    const embeddingsStatus = await embeddings.status(view.embeddingsModel);
    return c.json({
      plugins: snap.plugins,
      artifacts: hits.map(indexOf),
      search: { mode, model: view.embeddingsModel, cached: embeddingsStatus.cached }
    });
  });

  app.get('/api/artifact', async (c) => {
    const id = c.req.query('id');
    if (!id) {
      return c.json({ error: 'id is required' }, 400);
    }
    const artifact = await catalog.artifact(id);
    const available = await session.isAvailable(id);
    return c.json({ artifact, available });
  });

  app.put('/api/artifact', async (c) => {
    const id = c.req.query('id');
    if (!id) {
      return c.json({ error: 'id is required' }, 400);
    }
    const body = await c.req.json<{ raw?: string }>();
    if (typeof body.raw !== 'string') {
      return c.json({ error: 'raw is required' }, 400);
    }
    const artifact = await catalog.artifact(id);
    const plugin = await catalog.plugin(artifact.plugin);
    await assertInsideRoot(artifact.path, plugin.root);
    await writeFile(artifact.path, body.raw);
    catalog.invalidate();
    const next = await catalog.artifact(id);
    return c.json({ artifact: next });
  });

  app.get('/api/session', async (c) => c.json(await session.view()));

  app.post('/api/session/dynamic', async (c) => {
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled is required' }, 400);
    }
    return c.json(await session.setDynamicMode(body.enabled));
  });

  app.post('/api/session/hydrate', async (c) => {
    const ids = await readIds(c);
    if (!ids) {
      return c.json({ error: 'ids is required' }, 400);
    }
    return c.json(await session.hydrate(ids));
  });

  app.post('/api/session/dehydrate', async (c) => {
    const ids = await readIds(c);
    if (!ids) {
      return c.json({ error: 'ids is required' }, 400);
    }
    return c.json(await session.dehydrate(ids));
  });

  app.post('/api/session/pin', async (c) => {
    const ids = await readIds(c);
    if (!ids) {
      return c.json({ error: 'ids is required' }, 400);
    }
    return c.json(await session.pin(ids));
  });

  app.post('/api/session/unpin', async (c) => {
    const ids = await readIds(c);
    if (!ids) {
      return c.json({ error: 'ids is required' }, 400);
    }
    return c.json(await session.unpin(ids));
  });

  app.post('/api/session/hooks', async (c) => {
    const body = await c.req.json<{ ids?: string[]; active?: boolean }>();
    if (!body.ids?.length || typeof body.active !== 'boolean') {
      return c.json({ error: 'ids and active are required' }, 400);
    }
    return c.json(await session.setHooksActive(body.ids, body.active));
  });

  app.post('/api/session/mcp', async (c) => {
    const body = await c.req.json<{ ids?: string[]; active?: boolean }>();
    if (!body.ids?.length || typeof body.active !== 'boolean') {
      return c.json({ error: 'ids and active are required' }, 400);
    }
    return c.json(await session.setMcpLive(body.ids, body.active));
  });

  app.post('/api/plugins/:name/enabled', async (c) => {
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled is required' }, 400);
    }
    return c.json(await session.setPluginEnabled(c.req.param('name'), body.enabled));
  });

  app.post('/api/plugins', async (c) => {
    const body = await c.req.json<{ name?: string; description?: string }>();
    if (!body.name || !body.description) {
      return c.json({ error: 'name and description are required' }, 400);
    }
    const dest = await createPlugin({ name: body.name, description: body.description });
    catalog.invalidate();
    return c.json({ ok: true, path: dest }, 201);
  });

  app.post('/api/catalog/reload', async (c) => {
    catalog.invalidate();
    const snap = await catalog.load();
    return c.json({ plugins: snap.plugins.length, artifacts: snap.artifacts.length });
  });

  app.all('/mcp', (c) => mcp.fetch(c.req.raw));

  app.get('*', async (c) => {
    const file = await resolvePublicFile(c.req.path);
    if (!file) {
      return c.json({ error: 'not found' }, 404);
    }
    const data = await readFile(file);
    return c.body(data, 200, { 'Content-Type': mimeFor(file) });
  });

  app.onError((error, c) => c.json({ error: error.message }, 400));

  return { app, close: () => mcp.close() };
}

function isKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

async function readIds(c: { req: { json: () => Promise<{ ids?: string[] }> } }): Promise<string[] | undefined> {
  const body = await c.req.json();
  return body.ids?.length ? body.ids : undefined;
}

async function resolvePublicFile(urlPath: string): Promise<string | undefined> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, rel);
  const root = path.resolve(PUBLIC_DIR);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return undefined;
  }
  if (await isFile(candidate)) {
    return candidate;
  }
  if (!path.extname(rel) && (await isFile(path.join(PUBLIC_DIR, 'index.html')))) {
    return path.join(PUBLIC_DIR, 'index.html');
  }
  return undefined;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function mimeFor(file: string): string {
  return MIME[path.extname(file)] ?? 'application/octet-stream';
}
