import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { adaptPlugin } from './adapt.js';
import { assertInsideRoot, indexOf, type Catalog } from './catalog.js';
import {
  actionTarget,
  ENV_KINDS,
  filterInventory,
  toEnvKind,
  type ActionTarget,
  type EnvKind
} from './env-api.js';
import {
  setMcpEnabled,
  setPluginEnabled,
  setSkillEnabled,
  setSkillVisibility,
  type ActionResult,
  type ActionScope
} from './env/actions.js';
import { buildContextReport } from './env/context.js';
import { diagnose } from './env/doctor.js';
import { scanEnvironment } from './env/inventory.js';
import { CLIENTS, SKILL_VISIBILITIES, type Client, type SkillVisibility } from './env/types.js';
import { createYardServer } from './mcp.js';
import { PUBLIC_DIR } from './paths.js';
import { createPlugin } from './scaffold.js';
import { searchArtifacts } from './search.js';
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

export function createYardApp(catalog: Catalog, session: Session) {
  const mcp = createMcpHandler(() => createYardServer(catalog, session));
  const app = new Hono();
  app.use('*', localhostHostValidation());
  app.use('*', localhostOriginValidation());

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

  app.post('/api/adapt', async (c) => {
    const body = await c.req.json<{ source?: string; name?: string; dest?: string; register?: boolean }>();
    if (!body.source) {
      return c.json({ error: 'source is required' }, 400);
    }
    const report = await adaptPlugin({
      source: body.source,
      ...(body.name ? { name: body.name } : {}),
      ...(body.dest ? { dest: body.dest } : {}),
      ...(typeof body.register === 'boolean' ? { register: body.register } : {})
    });
    catalog.invalidate();
    return c.json({ ok: true, ...report }, 201);
  });

  app.get(
    '/api/env/inventory',
    envRoute(async (c) => {
      const client = clientParam(c.req.query('client'));
      const kind = kindParam(c.req.query('kind'));
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      return kind ? filterInventory(inventory, kind) : inventory;
    })
  );

  app.get(
    '/api/env/context',
    envRoute(async (c) => {
      const client = clientParam(c.req.query('client'));
      const probe = probeParam(c.req.query('probe'));
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      return buildContextReport(inventory, { probe });
    })
  );

  app.get(
    '/api/env/doctor',
    envRoute(async (c) => {
      const client = clientParam(c.req.query('client'));
      const probe = probeParam(c.req.query('probe'));
      const inventory = await scanEnvironment(process.cwd(), client ? { clients: [client] } : {});
      return { diagnoses: await diagnose(inventory, { probe }) };
    })
  );

  app.post(
    '/api/env/skill',
    envRoute(async (c) => {
      const body = await jsonBody(c);
      const skill = requiredString(body.skill, 'skill');
      const target = targetFrom(body);
      const { visibility, enabled } = body;

      if (visibility !== undefined && enabled !== undefined) {
        return badRequest('pass visibility or enabled, not both');
      }
      if (visibility !== undefined) {
        if (typeof visibility !== 'string' || !isVisibility(visibility)) {
          return badRequest(`visibility must be one of ${SKILL_VISIBILITIES.join(', ')}`);
        }
        return runAction(() => setSkillVisibility({ ...target, skill, visibility }));
      }
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          return badRequest('enabled must be a boolean');
        }
        return runAction(() => setSkillEnabled({ ...target, skill, enabled }));
      }
      return badRequest('visibility or enabled is required');
    })
  );

  app.post(
    '/api/env/plugin',
    envRoute(async (c) => {
      const body = await jsonBody(c);
      const plugin = requiredString(body.plugin, 'plugin');
      const enabled = requiredBoolean(body.enabled, 'enabled');
      return runAction(() => setPluginEnabled({ ...targetFrom(body), plugin, enabled }));
    })
  );

  app.post(
    '/api/env/mcp',
    envRoute(async (c) => {
      const body = await jsonBody(c);
      const server = requiredString(body.server, 'server');
      const enabled = requiredBoolean(body.enabled, 'enabled');
      return runAction(() => setMcpEnabled({ ...targetFrom(body), server, enabled }));
    })
  );

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

/** A request the caller can fix. Anything else escaping an env handler is ours. */
class BadRequest extends Error {}

function badRequest(message: string): never {
  throw new BadRequest(message);
}

/**
 * The env routes read and write the developer's real client config, so a failed
 * scan must not look like a typo in the request: only a BadRequest is the
 * caller's fault, everything else is a 500 they can escalate.
 */
function envRoute(run: (c: Context) => Promise<object>) {
  return async (c: Context) => {
    try {
      return c.json(await run(c));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, error instanceof BadRequest ? 400 : 500);
    }
  };
}

/**
 * The action layer refuses what it cannot do by throwing — unknown skill, a name
 * that is ambiguous across clients, a client with no such setting — and all of
 * those are about what was asked for. A syscall failure underneath is not, so it
 * keeps its 500.
 */
async function runAction(run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await run();
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string') {
      throw error;
    }
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return badRequest('body must be json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return badRequest('body must be a json object');
  }
  return raw as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return badRequest(`${field} is required`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    return badRequest(`${field} must be a boolean`);
  }
  return value;
}

function targetFrom(body: Record<string, unknown>): ActionTarget {
  const { id, client, scope, dryRun } = body;
  if (id !== undefined && (typeof id !== 'string' || !id.trim())) {
    return badRequest('id must be a non-empty string');
  }
  if (client !== undefined && (typeof client !== 'string' || !isClient(client))) {
    return badRequest(`client must be one of ${CLIENTS.join(', ')}`);
  }
  if (scope !== undefined && (typeof scope !== 'string' || !isActionScope(scope))) {
    return badRequest('scope must be one of user, project, local');
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return badRequest('dryRun must be a boolean');
  }
  return actionTarget({
    ...(id !== undefined ? { id } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(dryRun !== undefined ? { dryRun } : {})
  });
}

function clientParam(value: string | undefined): Client | undefined {
  if (!value) {
    return undefined;
  }
  if (!isClient(value)) {
    return badRequest(`client must be one of ${CLIENTS.join(', ')}`);
  }
  return value;
}

function kindParam(value: string | undefined): EnvKind | undefined {
  if (!value) {
    return undefined;
  }
  const kind = toEnvKind(value);
  if (!kind) {
    return badRequest(`kind must be one of ${ENV_KINDS.join(', ')}`);
  }
  return kind;
}

/**
 * Probing starts the developer's configured MCP servers, so it happens only when
 * the request says so in as many words. Anything unrecognised is refused rather
 * than read as consent.
 */
function probeParam(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value === 'false') {
    return false;
  }
  if (value === '1' || value === 'true') {
    return true;
  }
  return badRequest('probe must be 1 or 0');
}

function isClient(value: string): value is Client {
  return (CLIENTS as readonly string[]).includes(value);
}

function isActionScope(value: string): value is ActionScope {
  return value === 'user' || value === 'project' || value === 'local';
}

function isVisibility(value: string): value is SkillVisibility {
  return (SKILL_VISIBILITIES as readonly string[]).includes(value);
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
