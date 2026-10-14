import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoom, type LoomOptions } from '@loom/core';
import { createMcpServer } from './index.ts';

/** Run the MCP server over stdio. stdout is the protocol channel, so all logging goes to stderr. */
export async function runStdio(opts: LoomOptions = {}): Promise<void> {
  console.log = console.info = console.debug = console.warn = (...a: unknown[]) => console.error(...a);
  const loom = createLoom(opts);
  let t: NodeJS.Timeout | null = null;
  loom.ctx.onIndexNeeded.push(() => {
    if (t) clearTimeout(t);
    t = setTimeout(() => loom.embeddings.drain().catch((e) => console.error('[embed]', e)), 300);
  });
  const server = createMcpServer(loom);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    loom.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}
