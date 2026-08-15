import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Catalog } from './catalog.js';
import { createYardApp } from './http.js';
import { Session } from './session.js';
import type { Inventory } from './env/types.js';

test('health and catalog endpoints serve the marketplace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-http-'));
  const catalog = new Catalog();
  const session = new Session(catalog, path.join(dir, 'state.json'));
  const { app, close } = createYardApp(catalog, session);
  try {
    const headers = { Host: '127.0.0.1' };
    const health = await app.request('/api/health', { headers });
    assert.equal(health.status, 200);
    const catalogRes = await app.request('/api/catalog', {
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
    const body = (await catalogRes.json()) as { artifacts: Array<{ id: string }> };
    assert.ok(body.artifacts.some((item) => item.id === 'hello/skill/hello'));
    const page = await app.request('/', { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Yard/);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

const HEADERS = { Host: '127.0.0.1', 'Content-Type': 'application/json' };

type EnvFixture = {
  app: ReturnType<typeof createYardApp>['app'];
  /** The Claude Code settings file the actions write. */
  settings: string;
};

/**
 * Point the environment layer at a fixture home so the tests never read, and
 * never write, the developer's real client config. No test passes probe=1, so
 * no configured MCP server is ever started.
 */
async function withEnv(run: (fixture: EnvFixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-http-env-'));
  const claude = path.join(dir, 'home', '.claude');
  const previous = process.env.YARD_HOME;
  process.env.YARD_HOME = path.join(dir, 'home');
  const catalog = new Catalog();
  const session = new Session(catalog, path.join(dir, 'state.json'));
  const { app, close } = createYardApp(catalog, session);
  try {
    await mkdir(path.join(claude, 'skills', 'alpha'), { recursive: true });
    await writeFile(
      path.join(claude, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: Review a diff before it is pushed.\n---\n\nBody.\n'
    );
    await writeFile(path.join(claude, 'settings.json'), '{}\n');
    await run({ app, settings: path.join(claude, 'settings.json') });
  } finally {
    if (previous === undefined) {
      delete process.env.YARD_HOME;
    } else {
      process.env.YARD_HOME = previous;
    }
    await close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('env inventory filters by kind and client', async () => {
  await withEnv(async ({ app }) => {
    const res = await app.request('/api/env/inventory?client=claude&kind=skills', { headers: HEADERS });
    assert.equal(res.status, 200);
    const inventory = (await res.json()) as Inventory;
    assert.ok(inventory.skills.some((skill) => skill.name === 'alpha'));
    assert.deepEqual(inventory.plugins, []);
    assert.deepEqual(inventory.clients, ['claude']);
  });
});

test('env context and doctor report without probing', async () => {
  await withEnv(async ({ app }) => {
    const context = await app.request('/api/env/context', { headers: HEADERS });
    assert.equal(context.status, 200);
    const report = (await context.json()) as { probed: boolean; total: number };
    assert.equal(report.probed, false);
    assert.ok(report.total > 0);

    const doctor = await app.request('/api/env/doctor', { headers: HEADERS });
    assert.equal(doctor.status, 200);
    const { diagnoses } = (await doctor.json()) as { diagnoses: unknown[] };
    assert.ok(Array.isArray(diagnoses));
  });
});

test('an unrecognised probe value is refused rather than read as consent', async () => {
  await withEnv(async ({ app }) => {
    const res = await app.request('/api/env/context?probe=yes', { headers: HEADERS });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /probe/);
  });
});

test('a malformed env action body is a 400 naming the field', async () => {
  await withEnv(async ({ app }) => {
    const missingSkill = await app.request('/api/env/skill', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ visibility: 'off' })
    });
    assert.equal(missingSkill.status, 400);
    assert.match(((await missingSkill.json()) as { error: string }).error, /skill/);

    const badVisibility = await app.request('/api/env/skill', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ skill: 'alpha', visibility: 'sideways' })
    });
    assert.equal(badVisibility.status, 400);
    assert.match(((await badVisibility.json()) as { error: string }).error, /visibility/);

    const missingEnabled = await app.request('/api/env/plugin', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ plugin: 'demo' })
    });
    assert.equal(missingEnabled.status, 400);
    assert.match(((await missingEnabled.json()) as { error: string }).error, /enabled/);

    const missingServer = await app.request('/api/env/mcp', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(missingServer.status, 400);
    assert.match(((await missingServer.json()) as { error: string }).error, /server/);
  });
});

test('a dry run reports the change without writing it', async () => {
  await withEnv(async ({ app, settings }) => {
    const before = await readFile(settings, 'utf8');
    const res = await app.request('/api/env/skill', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ skill: 'alpha', visibility: 'off', client: 'claude', dryRun: true })
    });
    assert.equal(res.status, 200);
    const result = (await res.json()) as { changed: boolean; dryRun: boolean; file: string };
    assert.equal(result.changed, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.file, settings);
    assert.equal(await readFile(settings, 'utf8'), before);
  });
});

test('an action naming nothing that exists is the caller’s fault, not a crash', async () => {
  await withEnv(async ({ app }) => {
    const res = await app.request('/api/env/mcp', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ server: 'nope', enabled: false })
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not found/);
  });
});
