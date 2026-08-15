/**
 * Throughput of the offline token estimator, the pure-CPU core of `yard
 * context`. Run with `bun scripts/bench-tokens.ts` or `tsx scripts/bench-tokens.ts`.
 */

import { performance } from 'node:perf_hooks';
import { estimateTokens, type TokenKind } from '../src/env/tokens.js';

function corpus(kind: TokenKind, bytes: number): string {
  const prose =
    'Skills, MCP servers, subagents, slash commands, and memory files are all charged against the same context window as your actual conversation. ';
  const json =
    '{"name":"context7","command":"npx","args":["-y","@upstash/context7-mcp"],"env":{"API_KEY":"placeholder"},"enabled":true},';
  const code =
    'export function estimateTokens(text: string, kind: TokenKind = "prose"): number {\n  if (!text) {\n    return 0;\n  }\n';
  const unit = kind === 'prose' ? prose : kind === 'json' ? json : code;
  return unit.repeat(Math.ceil(bytes / unit.length));
}

const MB = 1024 * 1024;
const SIZE = 4 * MB;
const RUNS = 5;

for (const kind of ['prose', 'json', 'code'] as const) {
  const text = corpus(kind, SIZE);
  const bytes = Buffer.byteLength(text);
  estimateTokens(text, kind); // warmup

  let best = Infinity;
  let tokens = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    tokens = estimateTokens(text, kind);
    best = Math.min(best, performance.now() - start);
  }
  const mbPerSec = bytes / MB / (best / 1000);
  console.log(
    `${kind.padEnd(6)} ${(bytes / MB).toFixed(1)} MB -> ${tokens.toLocaleString('en-US')} tokens  ` +
      `${mbPerSec.toFixed(0)} MB/s (best of ${RUNS})`
  );
}
