const USAGE = `yard — one control plane for claude code, codex, and cursor

usage: yard <command> [options]

  scan                          what every client will load: counts, then the inventory
    --kind=skill|plugin|mcp|hook|agent|command|memory
  context [--probe]             what your setup costs in context, per turn, and what to turn off
  doctor [--probe]              what is quietly broken. exits 1 when anything is an error
  skill <name> <visibility>     visibility is on, name-only, user-invocable-only, or off
  skill <name> enable|disable   move a personal skill in or out of the skills directory
  plugin enable|disable <name>
  mcp enable|disable <name>
  serve [--port=4372]           the http ui and the mcp endpoint
  adapt <path>                  fill in codex and cursor files for a claude-only plugin
    --name=  --dest=  --register|--no-register
  new <name> <description>      scaffold a plugin into ./plugins

options everywhere:
  --json                        machine output, no colour
  --project=<path>              project to scan, defaults to the working directory
  --client=claude|codex|cursor  one client only, and the one to write to when a name is ambiguous

mutating commands also take:
  --dry-run                     print what would change, write nothing
  --scope=user|project|local    which settings file to write, defaults to user

legacy flags, unchanged:
  --stdio                       serve mcp over stdio
  --port=<port>                 serve the http ui on a port
  --emit-mcp                    rewrite the yard plugin's mcp files
  --adapt <path>                same as: yard adapt <path>
`;

export function printUsage(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(USAGE);
}
