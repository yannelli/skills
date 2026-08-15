import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  bar,
  colorEnabled,
  createStyle,
  pad,
  percent,
  plural,
  renderJson,
  renderTable,
  shortenPath,
  truncate,
  visibleWidth
} from './format.js';

test('columns are padded to the widest cell and numbers right-align', () => {
  const table = renderTable(
    [{ header: 'name' }, { header: 'tokens', align: 'right' }],
    [
      ['context7', '12.0k'],
      ['a-very-long-skill-name', '9']
    ]
  );

  assert.deepEqual(table.split('\n'), [
    `name${' '.repeat(20)}tokens`,
    `context7${' '.repeat(16)} 12.0k`,
    'a-very-long-skill-name       9'
  ]);

  for (const line of table.split('\n')) {
    assert.equal(line.length, 30, `line "${line}" is not 30 wide`);
  }
});

test('rows shorter than the header still line up, and trailing space is trimmed', () => {
  const table = renderTable([{ header: 'kind' }, { header: 'state' }], [['mcp'], ['skill', 'on']]);
  assert.deepEqual(table.split('\n'), ['kind   state', 'mcp', 'skill  on']);
});

test('cells longer than the column maximum are truncated with an ellipsis', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abc', 1), '…');
  assert.equal(truncate('abc', 0), '');

  const table = renderTable(
    [{ header: 'summary', max: 8 }, { header: 'code' }],
    [['a description far too long for the column', 'E1']]
  );
  assert.deepEqual(table.split('\n'), ['summary   code', 'a descr…  E1']);
});

test('a styled cell keeps the same layout as an unstyled one', () => {
  const style = createStyle(true);
  const rows = [['skill', style.green('on')], ['mcp', style.red('off')]];
  const plain = [['skill', 'on'], ['mcp', 'off']];
  const columns = [{ header: 'kind' }, { header: 'state' }];

  const styled = renderTable(columns, rows);
  assert.ok(styled.includes('\u001b['), 'expected escape sequences when colour is on');
  assert.equal(strip(styled), renderTable(columns, plain));
  assert.equal(visibleWidth(style.green('on')), 2);
});

test('padding respects alignment and never shrinks a value', () => {
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('ab', 5, 'right'), '   ab');
  assert.equal(pad('abcdef', 3), 'abcdef');
});

test('json output is parseable and free of escape sequences', () => {
  const payload = {
    projectRoot: '/home/dev/app',
    total: 48_210,
    lines: [{ label: 'context7', tokens: 12_004, remedy: 'yard mcp disable context7', detail: 'truncated…' }],
    byClient: { claude: 44_000, cursor: 4210 }
  };

  const rendered = renderJson(payload);
  assert.equal(rendered.includes('\u001b['), false);
  assert.deepEqual(JSON.parse(rendered), payload);
  assert.equal(renderJson(undefined), 'null');
  assert.deepEqual(JSON.parse(renderJson([])), []);
});

test('colour is never enabled for json output', () => {
  assert.equal(colorEnabled(true), false);
  assert.equal(createStyle(false).red('x'), 'x');
});

test('bars and shares scale against the largest value', () => {
  assert.equal(bar(10, 10, 4), '████');
  assert.equal(bar(0, 10, 4), '');
  assert.equal(bar(1, 1000, 10), '█', 'a non-zero value always draws something');
  assert.equal(bar(5, 0, 4), '');
  assert.equal(percent(1, 4), '25%');
  assert.equal(percent(1, 0), '0%');
});

test('paths print relative to the project, then relative to home', () => {
  const root = path.resolve('/home/dev/app');
  assert.equal(shortenPath(path.join(root, '.mcp.json'), root), '.mcp.json');
  assert.equal(shortenPath('', root), '');
  assert.equal(shortenPath('/etc/claude-code/managed-settings.json', root), '/etc/claude-code/managed-settings.json');
});

test('plural only adds an s when it should', () => {
  assert.equal(plural(1, 'error'), '1 error');
  assert.equal(plural(2, 'error'), '2 errors');
  assert.equal(plural(0, 'config file'), '0 config files');
});

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
