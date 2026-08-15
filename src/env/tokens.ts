/**
 * Offline token estimation.
 *
 * There is no published tokenizer for current Claude models, and the point of
 * the context ledger is ranking — "which of these is eating my window" — not
 * billing. So this approximates byte-pair segmentation directly instead of
 * using a flat chars-per-token divisor, which badly under-counts JSON (dense
 * punctuation) and over-counts prose.
 *
 * Every number Yard reports from here is labelled an estimate. Expect roughly
 * ±10% against a real BPE tokenizer, and consistent relative ordering.
 */

export type TokenKind = 'prose' | 'json' | 'code';

/**
 * A leading space belongs to the token that follows it, which is why the
 * pattern captures whitespace together with the run it precedes.
 */
const SEGMENT = /\s*(?:[A-Za-z]+|\d+|[^\sA-Za-z\d]+)|\s+/g;

export function estimateTokens(text: string, kind: TokenKind = 'prose'): number {
  if (!text) {
    return 0;
  }

  let total = 0;
  for (const [segment] of text.matchAll(SEGMENT)) {
    total += segmentTokens(segment);
  }

  // JSON and code carry more structural punctuation per unit of meaning than
  // the segmenter credits, because delimiters like `":"` and `},{` merge into
  // single tokens far more often than prose punctuation does.
  const factor = kind === 'prose' ? 1 : kind === 'json' ? 0.92 : 0.96;
  return Math.max(1, Math.round(total * factor));
}

function segmentTokens(segment: string): number {
  const body = segment.replace(/^\s+/, '');
  const hadLeadingSpace = body.length !== segment.length;

  if (!body) {
    // A run of pure whitespace. Newlines and indentation are cheap but not free.
    return Math.max(1, Math.ceil(segment.length / 8));
  }

  if (/^\d+$/.test(body)) {
    // Digits group in threes.
    return Math.ceil(body.length / 3);
  }

  if (/^[A-Za-z]+$/.test(body)) {
    // A common short word plus its leading space is one token. Longer words
    // split into word-piece chunks; camelCase and PascalCase split at the
    // case boundaries first.
    const pieces = body.split(/(?=[A-Z])/).filter(Boolean);
    if (pieces.length > 1) {
      return pieces.reduce((sum, piece) => sum + wordPieces(piece), 0);
    }
    return wordPieces(body, hadLeadingSpace);
  }

  // Punctuation. Pairs like `":` or `},` frequently merge into one token.
  return Math.max(1, Math.ceil(body.length / 1.8));
}

function wordPieces(word: string, hadLeadingSpace = false): number {
  const length = word.length;
  if (length <= (hadLeadingSpace ? 7 : 6)) {
    return 1;
  }
  return Math.ceil(length / 5);
}

/** Estimate the tokens a JSON value costs when serialised into a tool schema. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? '', 'json');
}

export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${Math.round(count / 1000)}k`;
}
