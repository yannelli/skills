import { cosine, type Embeddings } from './embed.js';
import type { ArtifactIndex, ArtifactKind, ArtifactRecord } from './types.js';

export type SearchQuery = {
  query: string;
  kinds?: ArtifactKind[];
  plugin?: string;
  limit?: number;
};

export type SearchMode = 'lexical' | 'embeddings';

export async function searchCatalog<T extends ArtifactRecord>(
  artifacts: T[],
  query: SearchQuery,
  semantic?: { embeddings: Embeddings; model: string }
): Promise<{ hits: T[]; mode: SearchMode }> {
  if (!semantic || !query.query.trim()) {
    return { hits: searchArtifacts(artifacts, query), mode: 'lexical' };
  }
  const filtered = filterArtifacts(artifacts, query);
  const limit = query.limit ?? 20;
  const vectors = await semantic.embeddings.vectorsFor(filtered, query.query, semantic.model);
  const tokens = tokenize(query.query);
  const scored = filtered
    .map((item, index) => {
      const lex = scoreArtifact(item, tokens, query.query);
      const cos = cosine(vectors.query, vectors.artifacts[index] ?? []);
      return { item, score: lex + cos * 80, lex, cos };
    })
    .filter((row) => row.lex > 0 || row.cos >= 0.18)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return { hits: scored.slice(0, limit).map((row) => row.item), mode: 'embeddings' };
}

export function searchArtifacts<T extends ArtifactIndex>(artifacts: T[], query: SearchQuery): T[] {
  const tokens = tokenize(query.query);
  const limit = query.limit ?? 20;
  const scored = filterArtifacts(artifacts, query)
    .map((item) => ({ item, score: scoreArtifact(item, tokens, query.query) }))
    .filter((row) => row.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, limit).map((row) => row.item);
}

function filterArtifacts<T extends ArtifactIndex>(artifacts: T[], query: SearchQuery): T[] {
  return artifacts
    .filter((item) => (query.kinds ? query.kinds.includes(item.kind) : true))
    .filter((item) => (query.plugin ? item.plugin === query.plugin : true));
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
