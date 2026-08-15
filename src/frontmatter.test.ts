import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from './frontmatter.js';

test('reads name and folded description', () => {
  const parsed = parseFrontmatter(`---
name: review
description: >
  Review selected code.
  Use on diffs.
---

# Body
`);
  assert.equal(parsed.data.name, 'review');
  assert.equal(parsed.data.description, 'Review selected code. Use on diffs.');
  assert.match(parsed.body, /# Body/);
});

test('returns raw body when frontmatter is missing', () => {
  const parsed = parseFrontmatter('just text');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, 'just text');
});
