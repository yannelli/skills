import type { ArtifactIndex, ArtifactKind } from './types.js';

export type SearchQuery = {
  query: string;
  kinds?: ArtifactKind[];
  plugin?: string;
  limit?: number;
};

export function searchArtifacts<T extends ArtifactIndex>(artifacts: T[], query: SearchQuery): T[] {
  const tokens = tokenize(query.query);
  const kinds = query.kinds;
  const plugin = query.plugin;
  const limit = query.limit ?? 20;

  const scored = artifacts
    .filter((item) => (kinds ? kinds.includes(item.kind) : true))
    .filter((item) => (plugin ? item.plugin === plugin : true))
    .map((item) => ({ item, score: scoreArtifact(item, tokens, query.query) }))
    .filter((row) => row.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

  return scored.slice(0, limit).map((row) => row.item);
}

function scoreArtifact(item: ArtifactIndex, tokens: string[], rawQuery: string): number {
  if (tokens.length === 0) {
    return 1;
  }
  const hay = `${item.id} ${item.name} ${item.plugin} ${item.kind} ${item.description}`.toLowerCase();
  const needle = rawQuery.trim().toLowerCase();
  let score = 0;
  if (item.name === needle) {
    score += 50;
  }
  if (item.name.startsWith(needle)) {
    score += 20;
  }
  if (item.id.includes(needle)) {
    score += 12;
  }
  for (const token of tokens) {
    if (item.name === token) {
      score += 10;
    } else if (item.name.includes(token)) {
      score += 6;
    }
    if (item.plugin.includes(token)) {
      score += 3;
    }
    if (item.kind.includes(token)) {
      score += 3;
    }
    if (hay.includes(token)) {
      score += 2;
    }
  }
  return score;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}
