import os from 'node:os';
import path from 'node:path';

/**
 * Rendering helpers for the terminal surface.
 *
 * Everything here is pure and returns a string. Nothing reads process.stdout,
 * so the commands stay testable and colour is always a decision the caller
 * makes once, at the top, where it knows whether --json was asked for.
 */

const ANSI = /\u001b\[[0-9;]*m/g;

export const ELLIPSIS = '…';

export type Align = 'left' | 'right';

export type Column = {
  header: string;
  align?: Align;
  /** Cells wider than this are cut and marked with an ellipsis. */
  max?: number;
  /**
   * Which end to cut. 'start' keeps the tail, which is what a column of paths
   * wants: forty rows all reading `~/.claude/plugins/cache/claude-plu…` name
   * nothing, while `…official/hookify/skills/writing-rules/SKILL.md` names the
   * file.
   */
  cut?: 'end' | 'start';
};

export type TableOptions = {
  /** Spaces between columns. */
  gap?: number;
  /** Set false to print rows only. */
  head?: boolean;
  headStyle?: (value: string) => string;
};

/** Width as the terminal sees it, with escape sequences discounted. */
export function visibleWidth(value: string): number {
  return value.replace(ANSI, '').length;
}

export function truncate(value: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (value.length <= max) {
    return value;
  }
  if (max === 1) {
    return ELLIPSIS;
  }
  return `${value.slice(0, max - 1)}${ELLIPSIS}`;
}

/** Cut from the left, keeping the identifying tail. */
export function truncateStart(value: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (value.length <= max) {
    return value;
  }
  if (max === 1) {
    return ELLIPSIS;
  }
  return `${ELLIPSIS}${value.slice(value.length - (max - 1))}`;
}

export function pad(value: string, width: number, align: Align = 'left'): string {
  const fill = ' '.repeat(Math.max(0, width - visibleWidth(value)));
  return align === 'right' ? `${fill}${value}` : `${value}${fill}`;
}

export function renderTable(
  columns: readonly Column[],
  rows: ReadonlyArray<readonly string[]>,
  options: TableOptions = {}
): string {
  const gap = ' '.repeat(options.gap ?? 2);
  const head = options.head !== false;
  const style = options.headStyle ?? ((value: string): string => value);

  const cells = rows.map((row) =>
    columns.map((column, index) => {
      const raw = row[index] ?? '';
      if (column.max === undefined) {
        return raw;
      }
      return column.cut === 'start' ? truncateStart(raw, column.max) : truncate(raw, column.max);
    })
  );

  const widths = columns.map((column, index) => {
    const start = head ? visibleWidth(column.header) : 0;
    return cells.reduce((widest, row) => Math.max(widest, visibleWidth(row[index] ?? '')), start);
  });

  const line = (values: readonly string[]): string =>
    columns
      .map((column, index) => pad(values[index] ?? '', widths[index] ?? 0, column.align))
      .join(gap)
      .trimEnd();

  const lines: string[] = [];
  if (head) {
    // Style before padding, so the padding stays outside the escape sequence
    // and a trailing column can still be trimmed.
    lines.push(line(columns.map((column) => style(column.header))));
  }
  for (const row of cells) {
    lines.push(line(row));
  }
  return lines.join('\n');
}

/** The one place --json output is serialised, so every command agrees. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

/** A solid bar sized against the largest value in the same table. */
export function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) {
    return '';
  }
  const filled = Math.max(1, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled);
}

export function percent(value: number, total: number): string {
  if (total <= 0) {
    return '0%';
  }
  return `${Math.round((value / total) * 100)}%`;
}

export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

/**
 * Paths are the widest thing in most of these tables, and the part that
 * identifies a file is the tail. Project files print relative to the project,
 * everything else relative to home.
 */
export function shortenPath(file: string, projectRoot?: string): string {
  if (!file) {
    return '';
  }
  if (projectRoot) {
    const relative = path.relative(projectRoot, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  const home = os.homedir();
  if (home && file.startsWith(home + path.sep)) {
    return `~${file.slice(home.length)}`;
  }
  return file;
}

export type Style = {
  dim(value: string): string;
  bold(value: string): string;
  red(value: string): string;
  yellow(value: string): string;
  green(value: string): string;
  cyan(value: string): string;
};

export function createStyle(enabled: boolean): Style {
  const wrap =
    (code: string) =>
    (value: string): string =>
      enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    yellow: wrap('33'),
    green: wrap('32'),
    cyan: wrap('36')
  };
}

export function colorEnabled(json: boolean): boolean {
  return !json && process.stdout.isTTY === true && !process.env.NO_COLOR;
}
