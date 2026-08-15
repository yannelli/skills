import { adaptPlugin } from '../adapt.js';
import { CliError, flagString, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';

export const ADAPT_USAGE = 'usage: yard --adapt <path> [--name=] [--dest=] [--register|--no-register]';

export type AdaptOptions = {
  source: string;
  name?: string;
  dest?: string;
  register?: boolean;
};

/**
 * The report is printed as JSON on stdout whether or not --json was asked for:
 * that is what this command has always done, and scripts already parse it.
 */
export async function runAdapt(options: AdaptOptions): Promise<number> {
  if (!options.source) {
    throw new CliError(ADAPT_USAGE);
  }
  const report = await adaptPlugin({
    source: options.source,
    ...(options.name ? { name: options.name } : {}),
    ...(options.dest ? { dest: options.dest } : {}),
    ...(options.register !== undefined ? { register: options.register } : {})
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

export async function runAdaptCommand(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS, 'name', 'dest', 'register', 'no-register']);
  const [source, extra] = args.positionals;
  if (extra !== undefined) {
    throw new CliError(`unexpected argument "${extra}" — ${ADAPT_USAGE}`);
  }
  const name = flagString(args, 'name');
  const dest = flagString(args, 'dest');
  const register = args.flags.has('register') ? true : args.flags.has('no-register') ? false : undefined;

  return runAdapt({
    source: source ?? '',
    ...(name ? { name } : {}),
    ...(dest ? { dest } : {}),
    ...(register !== undefined ? { register } : {})
  });
}
