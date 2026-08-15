import {
  buildContextReport,
  topOffenders,
  type ContextKind,
  type ContextLine,
  type ContextReport
} from '../env/context.js';
import { scanEnvironment } from '../env/inventory.js';
import { formatTokens } from '../env/tokens.js';
import { commonOptions, flagBool, flagNumber, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';
import { bar, colorEnabled, createStyle, percent, renderJson, renderTable, type Style } from './format.js';

export async function runContext(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS, 'client', 'probe', 'probe-timeout']);
  const options = commonOptions(args);
  const probe = flagBool(args, 'probe');
  const probeTimeoutMs = flagNumber(args, 'probe-timeout');

  const inventory = await scanEnvironment(options.projectRoot, {
    ...(options.client ? { clients: [options.client] } : {})
  });
  const report = await buildContextReport(inventory, {
    probe,
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {})
  });

  const offenders: ContextLine[] = topOffenders(report, 10).map((line) => ({
    ...line,
    ...(line.remedy ? { remedy: qualify(line.remedy, line.client, report) } : {})
  }));

  if (options.json) {
    console.log(renderJson({ ...report, offenders }));
    return 0;
  }

  printLedger(report, offenders, createStyle(colorEnabled(options.json)));
  return 0;
}

function printLedger(report: ContextReport, offenders: ContextLine[], style: Style): void {
  const head = (value: string): string => style.dim(value);

  if (!report.lines.length) {
    console.log('nothing is loaded, so nothing is charged against your context window');
    return;
  }

  console.log(
    `${style.bold(formatTokens(report.total))} estimated tokens per turn across ${report.clients.join(', ')}`
  );
  console.log('');

  const kinds = (Object.entries(report.byKind) as Array<[ContextKind, number]>)
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);
  const widestKind = kinds[0]?.[1] ?? 0;
  console.log(
    renderTable(
      [{ header: 'by kind' }, { header: 'tokens', align: 'right' }, { header: 'share', align: 'right' }, { header: '' }],
      kinds.map(([kind, tokens]) => [
        kind,
        formatTokens(tokens),
        percent(tokens, report.total),
        bar(tokens, widestKind)
      ]),
      { headStyle: head }
    )
  );
  console.log('');

  const clients = Object.entries(report.byClient)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const widestClient = clients[0]?.[1] ?? 0;
  console.log(
    renderTable(
      [
        { header: 'by client' },
        { header: 'tokens', align: 'right' },
        { header: 'share', align: 'right' },
        { header: '' }
      ],
      clients.map(([client, tokens]) => [
        client,
        formatTokens(tokens),
        percent(tokens, report.total),
        bar(tokens, widestClient)
      ]),
      { headStyle: head }
    )
  );
  console.log('');

  if (offenders.length) {
    console.log(
      renderTable(
        [
          { header: 'costliest' },
          { header: 'kind' },
          { header: 'client' },
          { header: 'tokens', align: 'right' },
          { header: 'detail', max: 40 },
          { header: 'turn it off', max: 46 }
        ],
        offenders.map((line) => [
          line.label,
          line.kind,
          line.client,
          formatTokens(line.tokens),
          line.measured ? (line.detail ?? '') : style.yellow(line.detail ?? 'estimated'),
          line.remedy ?? ''
        ]),
        { headStyle: head }
      )
    );
    console.log('');
  }

  for (const note of report.notes) {
    console.log(style.dim(note));
  }

  const next = offenders[0]?.remedy;
  console.log('');
  console.log(next ? `next: ${next}` : 'next: yard doctor');
}

/**
 * The same server name is often configured in two clients. A bare
 * `yard mcp disable context7` would then refuse as ambiguous, so the printed
 * command says which client it means.
 */
function qualify(remedy: string, client: string, report: ContextReport): string {
  const sharing = new Set(report.lines.filter((line) => line.remedy === remedy).map((line) => line.client));
  return sharing.size > 1 ? `${remedy} --client=${client}` : remedy;
}
