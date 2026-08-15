import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Catalog } from './catalog.js';
import { Session } from './session.js';

async function withSession(run: (session: Session) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-'));
  const session = new Session(new Catalog(), path.join(dir, 'state.json'));
  try {
    await run(session);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('dynamic mode hides bodies until hydrate, then attaches hooks', async () => {
  await withSession(async (session) => {
    await session.setDynamicMode(true);
    assert.equal(await session.isAvailable('review/skill/review'), false);
    const view = await session.hydrate(['review/skill/review']);
    assert.equal(await session.isAvailable('review/skill/review'), true);
    assert.ok(view.hydrated.includes('review/skill/review'));
    assert.deepEqual(view.hooksActive, []);
  });
});

test('hydrating hello activates that plugin’s hooks', async () => {
  await withSession(async (session) => {
    await session.setDynamicMode(true);
    const view = await session.hydrate(['hello/skill/hello']);
    assert.ok(view.hooksActive.includes('hello/hook/hooks'));
    assert.ok(view.hooksActive.includes('hello/hook/claude-hooks'));
    const after = await session.dehydrate(['hello/skill/hello']);
    assert.equal(after.hooksActive.length, 0);
  });
});

test('hydrating yard activates that plugin’s MCP', async () => {
  await withSession(async (session) => {
    await session.setDynamicMode(true);
    const view = await session.hydrate(['yard/skill/yard-control-plane']);
    assert.ok(view.mcpLive.includes('yard/mcp/yard'));
    const after = await session.dehydrate(['yard/skill/yard-control-plane']);
    assert.equal(after.mcpLive.length, 0);
  });
});

test('embeddings stay off until enabled', async () => {
  await withSession(async (session) => {
    const before = await session.view();
    assert.equal(before.embeddingsEnabled, false);
    assert.equal(before.embeddingsModel, 'voyageai/voyage-4-lite');
    const after = await session.setEmbeddings({ enabled: true, model: 'voyageai/voyage-4-lite' });
    assert.equal(after.embeddingsEnabled, true);
  });
});

test('pins stay available in dynamic mode', async () => {
  await withSession(async (session) => {
    await session.pin(['hello/skill/hello']);
    await session.setDynamicMode(true);
    assert.equal(await session.isAvailable('hello/skill/hello'), true);
    assert.equal(await session.isAvailable('review/skill/review'), false);
  });
});
