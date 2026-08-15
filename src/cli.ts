import { parseArgs, type Args } from './cli/args.js';
import { runAdapt, runAdaptCommand } from './cli/adapt.js';
import { runContext } from './cli/context.js';
import { runDoctor } from './cli/doctor.js';
import { runEmitMcp } from './cli/emit-mcp.js';
import { runMcp } from './cli/mcp.js';
import { runNew } from './cli/new.js';
import { runPlugin } from './cli/plugin.js';
import { runScan } from './cli/scan.js';
import { runServe, runServeCommand } from './cli/serve.js';
import { runSkill } from './cli/skill.js';
import { printUsage } from './cli/usage.js';

const COMMANDS: Record<string, (args: Args) => Promise<number>> = {
  scan: runScan,
  context: runContext,
  doctor: runDoctor,
  skill: runSkill,
  plugin: runPlugin,
  mcp: runMcp,
  serve: runServeCommand,
  adapt: runAdaptCommand,
  new: runNew
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printUsage();
    return 0;
  }

  // The flag surface predates the verbs and is in people's scripts, so it is
  // matched first and parsed exactly the way it always was.
  if (argv.includes('--emit-mcp')) {
    return runEmitMcp();
  }

  const adaptSource = flagValue('adapt');
  if (adaptSource !== undefined) {
    const register = argv.includes('--register') ? true : argv.includes('--no-register') ? false : undefined;
    const name = flagValue('name');
    const dest = flagValue('dest');
    return runAdapt({
      source: adaptSource,
      ...(name ? { name } : {}),
      ...(dest ? { dest } : {}),
      ...(register !== undefined ? { register } : {})
    });
  }

  const first = argv[0];
  if (first === undefined) {
    printUsage();
    return 0;
  }

  if (first.startsWith('-')) {
    const portFlag = argv.find((arg) => arg.startsWith('--port='));
    return runServe({
      stdio: argv.includes('--stdio'),
      ...(portFlag ? { port: Number(portFlag.slice('--port='.length)) } : {})
    });
  }

  const command = COMMANDS[first];
  if (!command) {
    process.stderr.write(`yard: unknown command "${first}"\n`);
    printUsage(process.stderr);
    return 1;
  }

  return command(parseArgs(argv));
}

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = process.argv.find((arg) => arg.startsWith(prefix));
  if (eq) {
    return eq.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) {
    return '';
  }
  return next;
}

main().then(
  (code) => {
    // Never process.exit here: `serve` has already returned with the listener
    // still open, and killing it would defeat the point.
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`yard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
