import type { ArtifactKind, SessionView } from './api'

export type ArtifactStatus = 'off' | 'pinned' | 'hydrated' | 'shelved' | 'open';

export function statusOf(id: string, session: SessionView | null): ArtifactStatus {
  if (!session) {
    return 'open';
  }
  const plugin = id.split('/')[0];
  if (plugin && session.disabledPlugins.includes(plugin)) {
    return 'off';
  }
  if (session.pinned.includes(id)) {
    return 'pinned';
  }
  if (session.hydrated.includes(id)) {
    return 'hydrated';
  }
  if (session.dynamicMode && !session.available.includes(id)) {
    return 'shelved';
  }
  return 'open';
}

export function statusLabel(status: ArtifactStatus): string {
  switch (status) {
    case 'off':
      return 'off';
    case 'pinned':
      return 'pinned';
    case 'hydrated':
      return 'hydrated';
    case 'shelved':
      return 'shelved';
    case 'open':
      return 'open';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function kindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'skill':
      return 'skill';
    case 'rule':
      return 'rule';
    case 'agent':
      return 'agent';
    case 'command':
      return 'command';
    case 'hook':
      return 'hook';
    case 'mcp':
      return 'mcp';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
