import { createPlugin } from '../scaffold.js';
import { CliError, commonOptions, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';
import { renderJson, shortenPath } from './format.js';

export async function runNew(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS]);
  const options = commonOptions(args);

  const [name, ...rest] = args.positionals;
  // An unquoted description is the common mistake and reads the same either way.
  const description = rest.join(' ').trim();
  if (!name || !description) {
    throw new CliError('usage: yard new <name> <description>');
  }

  const dest = await createPlugin({ name, description });
  if (options.json) {
    console.log(renderJson({ name, description, dest }));
    return 0;
  }
  console.log(`created ${shortenPath(dest, options.projectRoot)}`);
  return 0;
}
