import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  Embeddings,
  EmbeddingStore,
  artifactEmbedText,
  contentHash,
  cosine
} from './embed.js';
import { searchCatalog } from './search.js';
import type { ArtifactRecord } from './types.js';

const hello: ArtifactRecord = {
  id: 'hello/skill/hello',
  plugin: 'hello',
  kind: 'skill',
  name: 'hello',
  description: 'Greet the user',
  path: '/tmp/hello',
  version: '0.1.0',
  body: 'Say hello.',
  raw: 'Say hello.'
};

const review: ArtifactRecord = {
  id: 'review/skill/review',
  plugin: 'review',
  kind: 'skill',
  name: 'review',
  description: 'Review selected code for bugs',
  path: '/tmp/review',
  version: '0.1.0',
  body: 'Look for defects and security issues.',
  raw: 'Look for defects and security issues.'
};

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes('review') || lower.includes('bug') || lower.includes('defect') || lower.includes('security') ? 1 : 0,
    lower.includes('hello') || lower.includes('greet') ? 1 : 0
  ];
}

test('cosine is 1 for identical vectors', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.ok(cosine([1, 0], [0, 1]) < 0.01);
});

test('lexical search stays the default', async () => {
  const { hits, mode } = await searchCatalog([hello, review], { query: 'review' });
  assert.equal(mode, 'lexical');
  assert.equal(hits[0]?.id, 'review/skill/review');
});

test('embeddings search uses cached vectors and skips repeat OpenRouter calls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yard-embed-'));
  let calls = 0;
  const embeddings = new Embeddings(
    new EmbeddingStore(dir),
    'test-key',
    'voyageai/voyage-4-lite',
    (_apiKey, model) => ({
      model,
      async embed(texts: string[]) {
        calls += texts.length;
        return texts.map(fakeVector);
      }
    })
  );
  try {
    const first = await searchCatalog([hello, review], { query: 'find defects' }, { embeddings, model: 'voyageai/voyage-4-lite' });
    assert.equal(first.mode, 'embeddings');
    assert.equal(first.hits[0]?.id, 'review/skill/review');
    const afterFirst = calls;
    assert.ok(afterFirst >= 3);

    const second = await searchCatalog([hello, review], { query: 'find defects' }, { embeddings, model: 'voyageai/voyage-4-lite' });
    assert.equal(second.hits[0]?.id, 'review/skill/review');
    assert.equal(calls, afterFirst);

    const changed = { ...review, body: 'Look for defects and security issues. Extra.' };
    await searchCatalog([hello, changed], { query: 'find defects' }, { embeddings, model: 'voyageai/voyage-4-lite' });
    assert.equal(calls, afterFirst + 1);
    assert.equal(contentHash(artifactEmbedText(review)) !== contentHash(artifactEmbedText(changed)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
