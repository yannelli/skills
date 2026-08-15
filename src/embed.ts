import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord } from './types.js';

export const DEFAULT_EMBEDDINGS_MODEL = 'voyageai/voyage-4-lite';
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const BATCH = 32;
const MAX_CHARS = 8000;
const MAX_QUERY_CACHE = 200;

export type Embedder = {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
};

export type EmbeddingsStatus = {
  available: boolean;
  model: string;
  cached: number;
};

type CacheFile = {
  model: string;
  artifacts: Record<string, { hash: string; vector: number[] }>;
  queries: Record<string, { vector: number[] }>;
};

export function defaultEmbeddingsModel(): string {
  return process.env.YARD_EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
}

export function openRouterApiKey(): string | undefined {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? key : undefined;
}

export function createOpenRouterEmbedder(apiKey: string, model: string): Embedder {
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/yannelli/skills',
            'X-Title': 'Yard'
          },
          body: JSON.stringify({
            model,
            input: batch.length === 1 ? batch[0] : batch,
            encoding_format: 'float'
          })
        });
        if (!res.ok) {
          throw new Error(`OpenRouter embeddings ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== batch.length) {
          throw new Error(`OpenRouter embeddings returned ${rows.length} vectors for ${batch.length} inputs`);
        }
        for (const row of rows) {
          if (!row.embedding?.length) {
            throw new Error('OpenRouter embeddings response missing a vector');
          }
          out.push(row.embedding);
        }
      }
      return out;
    }
  };
}

export function artifactEmbedText(item: ArtifactRecord): string {
  const raw = `${item.id}\n${item.kind}\n${item.name}\n${item.description}\n${item.body}`;
  return raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  if (left === 0 || right === 0) {
    return 0;
  }
  return dot / Math.sqrt(left * right);
}

export class EmbeddingStore {
  constructor(private readonly dir: string) {}

  async load(model: string): Promise<CacheFile> {
    try {
      const raw = JSON.parse(await readFile(this.fileFor(model), 'utf8')) as CacheFile;
      if (raw.model !== model || !raw.artifacts || !raw.queries) {
        return emptyCache(model);
      }
      return raw;
    } catch {
      return emptyCache(model);
    }
  }

  async save(cache: CacheFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const dest = this.fileFor(cache.model);
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cache)}\n`);
    await rename(tmp, dest);
  }

  artifactCount(cache: CacheFile): number {
    return Object.keys(cache.artifacts).length;
  }

  private fileFor(model: string): string {
    return path.join(this.dir, `${model.replaceAll('/', '__')}.json`);
  }
}

export class Embeddings {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly embedders = new Map<string, Embedder>();

  constructor(
    private readonly store: EmbeddingStore,
    private readonly apiKey: string | undefined,
    private readonly fallbackModel: string = defaultEmbeddingsModel(),
    private readonly factory: (apiKey: string, model: string) => Embedder = createOpenRouterEmbedder
  ) {}

  static none(dir = path.join(process.cwd(), '.yard', 'embeddings')): Embeddings {
    return new Embeddings(new EmbeddingStore(dir), undefined);
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  model(): string {
    return this.fallbackModel;
  }

  async status(model = this.fallbackModel): Promise<EmbeddingsStatus> {
    const cache = await this.store.load(model);
    return {
      available: this.available(),
      model,
      cached: this.store.artifactCount(cache)
    };
  }

  async vectorsFor(
    artifacts: ArtifactRecord[],
    query: string,
    model: string
  ): Promise<{ query: number[]; artifacts: number[][] }> {
    return this.enqueue(async () => {
      const embedder = this.embedder(model);
      const cache = await this.store.load(model);
      const queryKey = contentHash(query);
      let queryVector = cache.queries[queryKey]?.vector;
      const missingTexts: string[] = [];
      const missingIds: string[] = [];
      const hashes = artifacts.map((item) => contentHash(artifactEmbedText(item)));

      for (let i = 0; i < artifacts.length; i += 1) {
        const item = artifacts[i];
        const hash = hashes[i];
        if (!item || !hash) {
          continue;
        }
        const hit = cache.artifacts[item.id];
        if (!hit || hit.hash !== hash) {
          missingIds.push(item.id);
          missingTexts.push(artifactEmbedText(item));
        }
      }

      const toEmbed = queryVector ? missingTexts : [query, ...missingTexts];
      if (toEmbed.length > 0) {
        const vectors = await embedder.embed(toEmbed);
        let offset = 0;
        if (!queryVector) {
          const next = vectors[0];
          if (!next) {
            throw new Error('OpenRouter embeddings returned no query vector');
          }
          queryVector = next;
          offset = 1;
        }
        for (let i = 0; i < missingIds.length; i += 1) {
          const id = missingIds[i];
          const item = artifacts.find((row) => row.id === id);
          const vector = vectors[offset + i];
          if (!id || !item || !vector) {
            continue;
          }
          cache.artifacts[id] = { hash: contentHash(artifactEmbedText(item)), vector };
        }
        cache.queries[queryKey] = { vector: queryVector };
        trimQueries(cache);
        await this.store.save(cache);
      }

      if (!queryVector) {
        throw new Error('query embedding is missing');
      }
      return {
        query: queryVector,
        artifacts: artifacts.map((item) => {
          const hash = contentHash(artifactEmbedText(item));
          const hit = cache.artifacts[item.id];
          if (!hit || hit.hash !== hash) {
            throw new Error(`missing embedding for ${item.id}`);
          }
          return hit.vector;
        })
      };
    });
  }

  async reindex(artifacts: ArtifactRecord[], model: string): Promise<EmbeddingsStatus> {
    return this.enqueue(async () => {
      const embedder = this.embedder(model);
      const cache = await this.store.load(model);
      const missingTexts: string[] = [];
      const missingIds: string[] = [];
      for (const item of artifacts) {
        const hash = contentHash(artifactEmbedText(item));
        const hit = cache.artifacts[item.id];
        if (!hit || hit.hash !== hash) {
          missingIds.push(item.id);
          missingTexts.push(artifactEmbedText(item));
        }
      }
      if (missingTexts.length > 0) {
        const vectors = await embedder.embed(missingTexts);
        for (let i = 0; i < missingIds.length; i += 1) {
          const id = missingIds[i];
          const item = artifacts.find((row) => row.id === id);
          const vector = vectors[i];
          if (!id || !item || !vector) {
            continue;
          }
          cache.artifacts[id] = { hash: contentHash(artifactEmbedText(item)), vector };
        }
        await this.store.save(cache);
      }
      return {
        available: this.available(),
        model,
        cached: this.store.artifactCount(cache)
      };
    });
  }

  private embedder(model: string): Embedder {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is not set');
    }
    const cached = this.embedders.get(model);
    if (cached) {
      return cached;
    }
    const created = this.factory(this.apiKey, model);
    this.embedders.set(model, created);
    return created;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function emptyCache(model: string): CacheFile {
  return { model, artifacts: {}, queries: {} };
}

function trimQueries(cache: CacheFile): void {
  const keys = Object.keys(cache.queries);
  if (keys.length <= MAX_QUERY_CACHE) {
    return;
  }
  for (const key of keys.slice(0, keys.length - MAX_QUERY_CACHE)) {
    delete cache.queries[key];
  }
}
