import type { ActionResult, ActionScope } from '../env/actions.js';
import type { Client } from '../env/types.js';
import { CliError, commonOptions, flagBool, flagEnum, GLOBAL_FLAGS, type Args } from './args.js';
import { colorEnabled, createStyle, renderJson, shortenPath } from './format.js';

/** Shared plumbing for the verbs that write to a developer's real config. */

export const MUTATION_FLAGS = [...GLOBAL_FLAGS, 'client', 'scope', 'dry-run'] as const;

const ACTION_SCOPES = ['user', 'project', 'local'] as const;

export type MutationOptions = {
  projectRoot: string;
  json: boolean;
  dryRun: boolean;
  client?: Client;
  scope?: ActionScope;
};

export function mutationOptions(args: Args): MutationOptions {
  const common = commonOptions(args);
  const scope = flagEnum(args, 'scope', ACTION_SCOPES);
  return {
    projectRoot: common.projectRoot,
    json: common.json,
    dryRun: flagBool(args, 'dry-run'),
    ...(common.client ? { client: common.client } : {}),
    ...(scope ? { scope } : {})
  };
}

/** The options every action takes, shaped so no optional is ever set to undefined. */
export function actionInput(options: MutationOptions): {
  projectRoot: string;
  dryRun: boolean;
  client?: Client;
  scope?: ActionScope;
} {
  return {
    projectRoot: options.projectRoot,
    dryRun: options.dryRun,
    ...(options.client ? { client: options.client } : {}),
    ...(options.scope ? { scope: options.scope } : {})
  };
}

export type Toggle = { name: string; enabled: boolean };

/**
 * `yard mcp disable context7` is the documented order, but a name-first
 * spelling is the obvious guess and costs nothing to accept.
 */
export function parseToggle(args: Args, usage: string): Toggle {
  const [first, second, extra] = args.positionals;
  if (extra !== undefined) {
    throw new CliError(`unexpected argument "${extra}" — usage: ${usage}`);
  }
  if (!first || !second) {
    throw new CliError(`usage: ${usage}`);
  }
  const action = isAction(first) ? first : isAction(second) ? second : undefined;
  if (!action) {
    throw new CliError(`expected enable or disable — usage: ${usage}`);
  }
  const name = action === first ? second : first;
  return { name, enabled: action === 'enable' };
}

export function isAction(value: string): value is 'enable' | 'disable' {
  return value === 'enable' || value === 'disable';
}

export function reportAction(result: ActionResult, options: MutationOptions): number {
  if (options.json) {
    console.log(renderJson(result));
    return 0;
  }
  const style = createStyle(colorEnabled(options.json));
  if (result.dryRun) {
    console.log(style.dim('dry run, nothing was written'));
  }
  console.log(result.detail);
  if (result.file) {
    console.log(style.dim(`file    ${shortenPath(result.file, options.projectRoot)}`));
  }
  if (result.backup) {
    console.log(style.dim(`backup  ${shortenPath(result.backup, options.projectRoot)}`));
  }
  return 0;
}
