import { writeMcpFiles } from '../mcp-spec.js';
import { YARD_PLUGIN_DIR } from '../paths.js';

export async function runEmitMcp(): Promise<number> {
  await writeMcpFiles(YARD_PLUGIN_DIR);
  console.error(`wrote ${YARD_PLUGIN_DIR}/.mcp.json`);
  console.error(`wrote ${YARD_PLUGIN_DIR}/mcp.json`);
  return 0;
}
