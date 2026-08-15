export const ARTIFACT_KINDS = ['skill', 'rule', 'agent', 'command', 'hook'] as const;

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
  disabledPlugins: string[];
};

export type SessionView = SessionState & {
  available: string[];
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
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled kind: ${_exhaustive}`);
    }
  }
}

export function defaultSession(): SessionState {
  return {
    dynamicMode: false,
    pinned: [],
    hydrated: [],
    hooksActive: [],
    disabledPlugins: []
  };
}
