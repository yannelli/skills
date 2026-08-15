import path from 'node:path';
import { CLIENTS, type Client } from '../env/types.js';

/**
 * Argument handling for the verb surface.
 *
 * Deliberately small: `--key=value`, `--key value`, and bare `--key` booleans.
 * The legacy flag surface in cli.ts keeps its own parser so its behaviour
 * cannot drift when this one grows.
 */

/** A failure the user caused. Printed as one line, never as a stack. */
export class CliError extends Error {}

export type Args = {
  verb: string | undefined;
  /** Everything after the verb that is not a flag. */
  positionals: string[];
  flags: Map<string, string | true>;
};

const VALUE_FLAGS = new Set(['project', 'client', 'kind', 'scope', 'name', 'dest', 'port', 'probe-timeout']);

export function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
      continue;
    }
    flags.set(body, true);
  }

  const [verb, ...rest] = positionals;
  return { verb, positionals: rest, flags };
}

export function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new CliError(`--${name} needs a value, as --${name}=<value>`);
  }
  return value;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) !== undefined;
}

export function flagNumber(args: Args, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${name} must be a number, got "${value}"`);
  }
  return parsed;
}

export function flagEnum<T extends string>(args: Args, name: string, allowed: readonly T[]): T | undefined {
  const value = flagString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new CliError(`--${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

export type CommonOptions = {
  projectRoot: string;
  json: boolean;
  client?: Client;
};

export function commonOptions(args: Args): CommonOptions {
  const client = flagEnum(args, 'client', CLIENTS);
  return {
    projectRoot: path.resolve(flagString(args, 'project') ?? process.cwd()),
    json: flagBool(args, 'json'),
    ...(client ? { client } : {})
  };
}

/** Reject typos rather than silently ignoring them — a mistyped filter lies. */
export function rejectUnknownFlags(args: Args, known: readonly string[]): void {
  for (const flag of args.flags.keys()) {
    if (!known.includes(flag)) {
      throw new CliError(`unknown flag --${flag}`);
    }
  }
}

export const GLOBAL_FLAGS = ['json', 'project', 'help'] as const;
