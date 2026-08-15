/**
 * Shared parsing for the two places Yard has to make sense of a command line
 * it did not write: a hook's `command` string (doctor.ts) and an MCP server's
 * `command`/`args`/`cwd`/`env` (probe.ts). Both need the same two things —
 * split a string into shell words without breaking a quoted variable
 * reference apart from the path it is glued to, then substitute the handful
 * of path variables Claude, Codex, and Cursor plugins all use.
 */

/**
 * Split a command line into words the way a shell would tokenize it, well
 * enough to recover a path argument. Handles single and double quotes, and —
 * the part a naive `match(/"[^"]*"|\S+/g)` gets wrong — merges a quoted
 * segment with unquoted text that touches it, so `"${VAR}"/rest` is one word,
 * not two. Not a full shell grammar: no globbing, command substitution, or
 * here-docs, and a `\`-escape is only honoured inside double quotes.
 */
export function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let hasCurrent = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i] as string;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasCurrent) {
        words.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      hasCurrent = true;
      const quote = char;
      i += 1;
      while (i < command.length && command[i] !== quote) {
        const next = command[i] as string;
        if (quote === '"' && next === '\\' && i + 1 < command.length) {
          const escaped = command[i + 1] as string;
          if (escaped === '"' || escaped === '\\' || escaped === '$') {
            current += escaped;
            i += 2;
            continue;
          }
        }
        current += next;
        i += 1;
      }
      // Falls through on an unterminated quote too — the word so far is kept
      // rather than thrown away, since a truncated token is still more useful
      // than none.
      i += 1;
      continue;
    }

    hasCurrent = true;
    current += char;
    i += 1;
  }

  if (hasCurrent) {
    words.push(current);
  }
  return words;
}

/**
 * Replace `${NAME}` and bare `$NAME` references with values from `vars`.
 * A reference to a name `vars` does not have is left exactly as written, so
 * callers can tell "expanded" apart from "unknowable from here" by checking
 * whether `$` is still present afterward.
 */
export function expandVariables(text: string, vars: Record<string, string>): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      const value = vars[name];
      return value !== undefined ? value : match;
    }
  );
}

/** True once every `$` reference in `text` was resolved by {@link expandVariables}. */
export function isFullyExpanded(text: string): boolean {
  return !text.includes('$');
}

/**
 * The path variables Claude Code, Codex, and Cursor plugins all substitute in
 * hook and MCP server commands. `pluginRoot` is only meaningful for a
 * plugin-scoped command, so it is omitted (rather than left `undefined` in the
 * map) when there is none — an unknown plugin variable must stay unresolved,
 * not resolve to `"undefined"`.
 */
export function pathVariables(opts: { pluginRoot?: string; projectRoot?: string }): Record<string, string> {
  const vars: Record<string, string> = {};
  if (opts.projectRoot !== undefined) {
    vars.CLAUDE_PROJECT_DIR = opts.projectRoot;
    vars.PROJECT_ROOT = opts.projectRoot;
  }
  if (opts.pluginRoot !== undefined) {
    vars.CLAUDE_PLUGIN_ROOT = opts.pluginRoot;
    vars.PLUGIN_ROOT = opts.pluginRoot;
  }
  return vars;
}
