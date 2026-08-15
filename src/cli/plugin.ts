import { setPluginEnabled } from '../env/actions.js';
import { rejectUnknownFlags, type Args } from './args.js';
import { actionInput, MUTATION_FLAGS, mutationOptions, parseToggle, reportAction } from './mutate.js';

export async function runPlugin(args: Args): Promise<number> {
  rejectUnknownFlags(args, MUTATION_FLAGS);
  const options = mutationOptions(args);
  const toggle = parseToggle(args, 'yard plugin enable|disable <name>');

  const result = await setPluginEnabled({
    ...actionInput(options),
    plugin: toggle.name,
    enabled: toggle.enabled
  });
  return reportAction(result, options);
}
