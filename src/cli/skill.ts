import { setSkillEnabled, setSkillVisibility } from '../env/actions.js';
import { SKILL_VISIBILITIES, type SkillVisibility } from '../env/types.js';
import { CliError, rejectUnknownFlags, type Args } from './args.js';
import { actionInput, isAction, MUTATION_FLAGS, mutationOptions, reportAction } from './mutate.js';

const USAGE = `yard skill <name> <${SKILL_VISIBILITIES.join('|')}|enable|disable>`;

export async function runSkill(args: Args): Promise<number> {
  rejectUnknownFlags(args, MUTATION_FLAGS);
  const options = mutationOptions(args);

  const [first, second, extra] = args.positionals;
  if (extra !== undefined) {
    throw new CliError(`unexpected argument "${extra}" — usage: ${USAGE}`);
  }
  if (!first || !second) {
    throw new CliError(`usage: ${USAGE}`);
  }

  const skill = isAction(first) ? second : first;
  const verb = isAction(first) ? first : second;

  if (isAction(verb)) {
    const result = await setSkillEnabled({ ...actionInput(options), skill, enabled: verb === 'enable' });
    return reportAction(result, options);
  }

  if (!isVisibility(verb)) {
    throw new CliError(`unknown visibility "${verb}" — expected one of ${SKILL_VISIBILITIES.join(', ')}, enable, disable`);
  }

  const result = await setSkillVisibility({ ...actionInput(options), skill, visibility: verb });
  return reportAction(result, options);
}

function isVisibility(value: string): value is SkillVisibility {
  return (SKILL_VISIBILITIES as readonly string[]).includes(value);
}
