import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchArtifacts } from './search.js';
import type { ArtifactIndex } from './types.js';

const items: ArtifactIndex[] = [
  {
    id: 'hello/skill/hello',
    plugin: 'hello',
    kind: 'skill',
    name: 'hello',
    description: 'Greet the user',
    path: '/tmp/hello',
    version: '0.1.0'
  },
  {
    id: 'review/skill/review',
    plugin: 'review',
    kind: 'skill',
    name: 'review',
    description: 'Review selected code for bugs',
    path: '/tmp/review',
    version: '0.1.0'
  }
];

test('ranks an exact name match first', () => {
  const hits = searchArtifacts(items, { query: 'review' });
  assert.equal(hits[0]?.id, 'review/skill/review');
});

test('filters by kind', () => {
  const hits = searchArtifacts(items, { query: '', kinds: ['skill'], limit: 10 });
  assert.equal(hits.length, 2);
});
