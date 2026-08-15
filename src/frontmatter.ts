export type Frontmatter = {
  data: Record<string, string>;
  body: string;
};

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): Frontmatter {
  const match = FENCE.exec(raw);
  if (!match) {
    return { data: {}, body: raw };
  }
  const data: Record<string, string> = {};
  let pendingKey: string | undefined;
  let pendingLines: string[] = [];

  const flush = (): void => {
    if (!pendingKey) {
      return;
    }
    data[pendingKey] = pendingLines.join(' ').replace(/\s+/g, ' ').trim();
    pendingKey = undefined;
    pendingLines = [];
  };

  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const keyed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyed) {
      flush();
      const key = keyed[1];
      const value = keyed[2] ?? '';
      if (!key) {
        continue;
      }
      if (value === '>' || value === '|') {
        pendingKey = key;
        pendingLines = [];
        continue;
      }
      data[key] = stripQuotes(value);
      continue;
    }
    if (pendingKey && /^\s+/.test(line)) {
      pendingLines.push(line.trim());
      continue;
    }
  }
  flush();

  return { data, body: raw.slice(match[0].length) };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
