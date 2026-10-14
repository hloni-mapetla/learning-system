#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLoom, defaultDbPath } from '@loom/core';
import { buildApp } from './app.ts';

const HELP = `loom — personal learning system

Usage: loom <command> [options]

  serve [--port 4317] [--host 127.0.0.1]   Web UI + REST API (+ HTTP MCP at /mcp)
  mcp                                       MCP server over stdio (Claude Desktop / Claude Code)
  reindex                                   (Re)compute embeddings for everything
  help

Environment: LOOM_DB (default ${defaultDbPath()}), LOOM_DATA_DIR, LOOM_NO_EMBED=1 to disable semantic search.`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { port: { type: 'string' }, host: { type: 'string' } },
    allowPositionals: true,
    strict: false,
  });
  const loom = () => createLoom(process.env.LOOM_NO_EMBED ? { embedder: null } : {});

  switch (cmd) {
    case 'serve': {
      const l = loom();
      const { app, scheduleEmbed } = buildApp(l);
      const port = Number(values.port ?? process.env.PORT ?? 4317);
      const host = String(values.host ?? process.env.HOST ?? '127.0.0.1');
      app.listen(port, host, () => {
        console.log(`loom: http://${host}:${port}  (db: ${l.db.path})`);
      });
      if (l.embeddings.reindexAll() || l.embeddings.pending()) scheduleEmbed();
      break;
    }
    case 'reindex': {
      const l = loom();
      console.log(`queued ${l.embeddings.reindexAll()} items; embedding…`);
      const n = await l.embeddings.drain();
      console.log(`embedded ${n} items`);
      l.close();
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
