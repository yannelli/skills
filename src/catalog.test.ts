import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.js';

test('indexes hello and review from the marketplace', async () => {
  const catalog = new Catalog();
  const snap = await catalog.load();
  const names = snap.plugins.map((plugin) => plugin.name).sort();
  assert.deepEqual(names, ['hello', 'review', 'yard']);
  assert.ok(snap.artifacts.some((item) => item.id === 'hello/skill/hello'));
  assert.ok(snap.artifacts.some((item) => item.id === 'review/skill/review'));
  assert.ok(snap.artifacts.some((item) => item.id === 'hello/rule/concise-replies'));
  assert.ok(snap.artifacts.some((item) => item.id === 'hello/hook/hooks'));
  assert.ok(snap.artifacts.some((item) => item.id === 'yard/skill/yard-control-plane'));
  assert.ok(snap.artifacts.some((item) => item.id === 'yard/mcp/yard'));
});
