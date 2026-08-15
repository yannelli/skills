import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Catalog } from './catalog.js';
import { createYardApp } from './http.js';
import { Session } from './session.js';

test('health and catalog endpoints serve the marketplace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-http-'));
  const catalog = new Catalog();
  const session = new Session(catalog, path.join(dir, 'state.json'));
  const { app, close } = createYardApp(catalog, session);
  try {
    const headers = { Host: '127.0.0.1' };
    const health = await app.request('/api/health', { headers });
    assert.equal(health.status, 200);
    const catalogRes = await app.request('/api/catalog', { headers });
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
