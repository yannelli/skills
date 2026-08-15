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

export type SessionState = {
  dynamicMode: boolean;
  pinned: string[];
  hydrated: string[];
  hooksActive: string[];
  mcpLive: string[];
  disabledPlugins: string[];
  embeddingsEnabled: boolean;
  embeddingsModel: string;
};

export type SessionView = SessionState & {
  available: string[];
};

export type McpTransport =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string };

export type McpServerSpec = {
  key: string;
  plugin: string;
  transport: McpTransport;
  source: 'claude' | 'agent';
};

export function artifactId(plugin: string, kind: ArtifactKind, name: string): string {
  return `${plugin}/${kind}/${name}`;
}

export function parseArtifactId(id: string): { plugin: string; kind: ArtifactKind; name: string } {
  const parts = id.split('/');
  if (parts.length !== 3) {
    throw new Error(`invalid artifact id: ${id}`);
  }
  const [plugin, kind, name] = parts;
  if (!plugin || !kind || !name) {
    throw new Error(`invalid artifact id: ${id}`);
  }
  if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    throw new Error(`invalid artifact kind: ${kind}`);
  }
  return { plugin, kind: kind as ArtifactKind, name };
}

export function kindDirectory(kind: ArtifactKind): string {
  switch (kind) {
    case 'skill':
      return 'skills';
    case 'rule':
      return 'rules';
    case 'agent':
      return 'agents';
    case 'command':
      return 'commands';
    case 'hook':
      return 'hooks';
    case 'mcp':
      return '';
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled kind: ${_exhaustive}`);
    }
  }
}

export function defaultSession(embeddingsModel = 'voyageai/voyage-4-lite'): SessionState {
  return {
    dynamicMode: false,
    pinned: [],
    hydrated: [],
    hooksActive: [],
    mcpLive: [],
    disabledPlugins: [],
    embeddingsEnabled: false,
    embeddingsModel
  };
}
