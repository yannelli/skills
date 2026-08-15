export const ARTIFACT_KINDS = ['skill', 'rule', 'agent', 'command', 'hook', 'mcp'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactIndex = {
  id: string;
  plugin: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  path: string;
  version: string;
};

export type ArtifactRecord = ArtifactIndex & {
  body: string;
  raw: string;
};

export type PluginRecord = {
  name: string;
  description: string;
  version: string;
  source: string;
  root: string;
};

export type SessionView = {
  dynamicMode: boolean;
  pinned: string[];
  hydrated: string[];
  hooksActive: string[];
  mcpLive: string[];
  disabledPlugins: string[];
  available: string[];
};

export type CatalogResponse = {
  plugins: PluginRecord[];
  artifacts: ArtifactIndex[];
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data: { error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string };
    } catch {
      throw new Error(text);
    }
  }
  if (!res.ok) {
    throw new Error(data.error ?? (text || res.statusText));
  }
  return data as T;
}

export function postIds(path: string, ids: string[]): Promise<SessionView> {
  return api<SessionView>(path, { method: 'POST', body: JSON.stringify({ ids }) });
}
