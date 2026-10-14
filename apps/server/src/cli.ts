#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLoom, defaultDbPath } from '@loom/core';
import { buildApp } from './app.ts';
import { mountMcp } from './mcpHttp.ts';
import { tokenStore } from './tokens.ts';
import { runStdio } from '@loom/mcp/stdio';
import { renderGuide } from '@loom/mcp';
import { writeFileSync } from 'node:fs';

const HELP = `loom — personal learning system

Usage: loom <command> [options]

  serve [--port 4317] [--host 127.0.0.1]   Web UI + REST API (+ HTTP MCP at /mcp)
  mcp                                       MCP server over stdio (Claude Desktop / Claude Code)
  token create [name] | list | revoke <id>  Bearer tokens for the HTTP MCP endpoint
  guide [file]                              Write the Claude Project instructions (session scripts)
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
      const tokens = tokenStore(l);
      const { app, scheduleEmbed } = buildApp(l, {
        extend: (a) =>
          mountMcp(a, l, (req, res) => {
            const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
            if (m && tokens.verify(m[1].trim())) return true;
            res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
            return false;
          }),
      });
      const port = Number(values.port ?? process.env.PORT ?? 4317);
      const host = String(values.host ?? process.env.HOST ?? '127.0.0.1');
      app.listen(port, host, () => {
        console.log(`loom: http://${host}:${port}  (db: ${l.db.path})`);
      });
      if (l.embeddings.reindexAll() || l.embeddings.pending()) scheduleEmbed();
      break;
    }
    case 'mcp': {
      await runStdio(process.env.LOOM_NO_EMBED ? { embedder: null } : {});
      break;
    }
    case 'token': {
      const l = loom();
      const tokens = tokenStore(l);
      const [sub, arg] = rest;
      if (sub === 'create') {
        const { id, token } = tokens.create(arg ?? 'default');
        console.log(`Created token ${id} (${arg ?? 'default'}). Store it now; it won't be shown again:\n\n  ${token}\n`);
      } else if (sub === 'revoke' && arg) {
        console.log(tokens.revoke(arg) ? `Revoked ${arg}` : `No token ${arg}`);
      } else {
        const list = tokens.list();
        console.log(list.length ? list.map((t) => `${t.id}  ${t.name}  created ${t.createdAt}`).join('\n') : 'No tokens. Run: loom token create <name>');
      }
      l.close();
      break;
    }
    case 'guide': {
      const out = rest[0];
      if (out) {
        writeFileSync(out, renderGuide());
        console.log(`Wrote ${out}`);
      } else process.stdout.write(renderGuide());
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
