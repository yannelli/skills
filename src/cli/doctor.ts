import { diagnose, type Diagnosis, type Severity } from '../env/doctor.js';
import { scanEnvironment } from '../env/inventory.js';
import { commonOptions, flagBool, flagNumber, GLOBAL_FLAGS, rejectUnknownFlags, type Args } from './args.js';
import {
  colorEnabled,
  createStyle,
  plural,
  renderJson,
  renderTable,
  shortenPath,
  truncate,
  type Style
} from './format.js';

const DETAIL_WIDTH = 96;

export async function runDoctor(args: Args): Promise<number> {
  rejectUnknownFlags(args, [...GLOBAL_FLAGS, 'client', 'probe', 'probe-timeout']);
  const options = commonOptions(args);
  const probe = flagBool(args, 'probe');
  const probeTimeoutMs = flagNumber(args, 'probe-timeout');

  const inventory = await scanEnvironment(options.projectRoot, {
    ...(options.client ? { clients: [options.client] } : {})
  });
  const found = await diagnose(inventory, {
    probe,
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {})
  });

  const errors = found.filter((item) => item.severity === 'error').length;

  if (options.json) {
    console.log(renderJson({ projectRoot: inventory.projectRoot, clients: inventory.clients, diagnoses: found }));
    return errors ? 1 : 0;
  }

  const style = createStyle(colorEnabled(options.json));
  if (!found.length) {
    console.log('no problems found');
    return 0;
  }

  // Each diagnosis is a row plus, where there is one, an indented remedy row.
  // Keeping the remedy in the table means it stays aligned under the summary
  // instead of drifting as the code column changes width.
  const rows: string[][] = [];
  for (const item of found) {
    rows.push([severityLabel(item.severity, style), item.client, item.code, truncate(item.summary, DETAIL_WIDTH)]);
    if (item.remedy) {
      rows.push(['', '', '', style.dim(truncate(`fix: ${item.remedy}`, DETAIL_WIDTH))]);
    }
    if (item.file) {
      rows.push(['', '', '', style.dim(truncate(shortenPath(item.file, inventory.projectRoot), DETAIL_WIDTH))]);
    }
  }

  console.log(
    renderTable(
      [{ header: 'severity' }, { header: 'client' }, { header: 'code' }, { header: 'what is wrong' }],
      rows,
      { headStyle: (value) => style.dim(value) }
    )
  );
  console.log('');
  console.log(summarise(found));
  return errors ? 1 : 0;
}

function summarise(found: Diagnosis[]): string {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const item of found) {
    counts[item.severity] += 1;
  }
  const parts = (['error', 'warning', 'info'] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => plural(counts[severity], severity));
  return parts.join(', ');
}

function severityLabel(severity: Severity, style: Style): string {
  if (severity === 'error') {
    return style.red(severity);
  }
  if (severity === 'warning') {
    return style.yellow(severity);
  }
  return style.dim(severity);
}
