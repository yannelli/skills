/** Mirrors formatTokens in src/env/tokens.ts so both surfaces round alike. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${Math.round(count / 1000)}k`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 100);
}

/**
 * Absolute paths are long and the interesting end is the right one, so the head
 * is what gets dropped. The full path always stays available as a title.
 */
export function shortenPath(file: string, keep = 3): string {
  const parts = file.split('/').filter(Boolean);
  if (parts.length <= keep) {
    return file;
  }
  return `…/${parts.slice(-keep).join('/')}`;
}

export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return fallback;
}
