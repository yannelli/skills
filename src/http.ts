import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { assertInsideRoot, indexOf, type Catalog } from './catalog.js';
import { createYardServer } from './mcp.js';
import { PUBLIC_DIR } from './paths.js';
import { createPlugin } from './scaffold.js';
import { searchArtifacts } from './search.js';
import type { Session } from './session.js';
import { ARTIFACT_KINDS, type ArtifactKind } from './types.js';

export function createYardApp(catalog: Catalog, session: Session) {
  const mcp = createMcpHandler(() => createYardServer(catalog, session));
  const app = createMcpHonoApp({ host: '127.0.0.1' });

  app.get('/api/health', (c) => c.json({ ok: true, name: 'yard' }));

  app.get('/api/catalog', async (c) => {
    const snap = await catalog.load();
    const query = c.req.query('q') ?? '';
    const kind = c.req.query('kind');
    const plugin = c.req.query('plugin');
    const kinds = kind && isKind(kind) ? [kind] : undefined;
    const artifacts = searchArtifacts(snap.artifacts, {
      query,
      ...(kinds ? { kinds } : {}),
      ...(plugin ? { plugin } : {}),
      limit: 100
    });
    return c.json({
      plugins: snap.plugins,
      artifacts: artifacts.map(indexOf)
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

  app.get('/', async (c) => {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return c.html(html);
  });
  app.get('/styles.css', async (c) => {
    const css = await readFile(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });
  app.get('/app.js', async (c) => {
    const js = await readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    return c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
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
