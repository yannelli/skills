import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog } from './catalog.js';
import { SESSION_FILE } from './paths.js';
import { defaultSession, type SessionState, type SessionView } from './types.js';

export class Session {
  constructor(
    private readonly catalog: Catalog,
    private readonly file: string = SESSION_FILE
  ) {}

  async read(): Promise<SessionState> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SessionState>;
      return {
        ...defaultSession(),
        ...raw,
        pinned: unique(raw.pinned ?? []),
        hydrated: unique(raw.hydrated ?? []),
        hooksActive: unique(raw.hooksActive ?? []),
        disabledPlugins: unique(raw.disabledPlugins ?? [])
      };
    } catch {
      return defaultSession();
    }
  }

  async view(): Promise<SessionView> {
    const state = await this.read();
    return { ...state, available: await this.availableIds(state) };
  }

  async isAvailable(id: string): Promise<boolean> {
    const state = await this.read();
    return (await this.availableIds(state)).includes(id);
  }

  async setDynamicMode(enabled: boolean): Promise<SessionView> {
    const state = await this.read();
    state.dynamicMode = enabled;
    if (!enabled) {
      state.hydrated = [];
    }
    await this.write(state);
    return this.view();
  }

  async pin(ids: string[]): Promise<SessionView> {
    await this.assertKnown(ids);
    const state = await this.read();
    state.pinned = unique([...state.pinned, ...ids]);
    await this.write(state);
    return this.view();
  }

  async unpin(ids: string[]): Promise<SessionView> {
    const drop = new Set(ids);
    const state = await this.read();
    state.pinned = state.pinned.filter((id) => !drop.has(id));
    await this.write(state);
    return this.view();
  }

  async hydrate(ids: string[]): Promise<SessionView> {
    await this.assertKnown(ids);
    const state = await this.read();
    state.hydrated = unique([...state.hydrated, ...ids]);
    const hookIds = await this.hooksForArtifacts(ids);
    state.hooksActive = unique([...state.hooksActive, ...hookIds]);
    await this.write(state);
    return this.view();
  }

  async dehydrate(ids: string[]): Promise<SessionView> {
    const drop = new Set(ids);
    const state = await this.read();
    state.hydrated = state.hydrated.filter((id) => !drop.has(id));
    const remaining = new Set([...state.hydrated, ...state.pinned]);
    const staleHooks = await this.hooksForArtifacts(ids);
    state.hooksActive = state.hooksActive.filter((hookId) => {
      if (!staleHooks.includes(hookId)) {
        return true;
      }
      const plugin = hookId.split('/')[0];
      return [...remaining].some((id) => id.startsWith(`${plugin}/`));
    });
    await this.write(state);
    return this.view();
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<SessionView> {
    await this.catalog.plugin(name);
    const state = await this.read();
    const disabled = new Set(state.disabledPlugins);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    state.disabledPlugins = [...disabled].sort();
    await this.write(state);
    return this.view();
  }

  async setHooksActive(ids: string[], active: boolean): Promise<SessionView> {
    await this.assertKnown(ids);
    const state = await this.read();
    if (active) {
      state.hooksActive = unique([...state.hooksActive, ...ids]);
    } else {
      const drop = new Set(ids);
      state.hooksActive = state.hooksActive.filter((id) => !drop.has(id));
    }
    await this.write(state);
    return this.view();
  }

  private async availableIds(state: SessionState): Promise<string[]> {
    const { artifacts } = await this.catalog.load();
    const enabled = artifacts.filter((item) => !state.disabledPlugins.includes(item.plugin));
    if (!state.dynamicMode) {
      return enabled.map((item) => item.id);
    }
    const open = new Set([...state.pinned, ...state.hydrated]);
    return enabled.filter((item) => open.has(item.id)).map((item) => item.id);
  }

  private async hooksForArtifacts(ids: string[]): Promise<string[]> {
    const { artifacts } = await this.catalog.load();
    const plugins = new Set(ids.map((id) => id.split('/')[0]).filter((name): name is string => Boolean(name)));
    return artifacts
      .filter((item) => item.kind === 'hook' && plugins.has(item.plugin))
      .map((item) => item.id);
  }

  private async assertKnown(ids: string[]): Promise<void> {
    const { artifacts } = await this.catalog.load();
    const known = new Set(artifacts.map((item) => item.id));
    for (const id of ids) {
      if (!known.has(id)) {
        throw new Error(`unknown artifact: ${id}`);
      }
    }
  }

  private async write(state: SessionState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
