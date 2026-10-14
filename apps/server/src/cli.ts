#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLoom, defaultDbPath } from '@loom/core';
import { serve } from './serve.ts';
import { LoomOAuthProvider, setOwnerPassword } from './oauth.ts';
import { tokenStore } from './tokens.ts';
import { runStdio } from '@loom/mcp/stdio';
import { renderGuide } from '@loom/mcp';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const HELP = `loom — personal learning system

Usage: loom <command> [options]

  serve [--port 4317] [--public-url URL] [--public-port 4318]
                                            Web UI + API (+ /mcp with tokens); with a public URL, also an
                                            OAuth-protected MCP-only listener for the tunnel
  set-password                              Password for approving remote Claude connectors (OAuth)
  revoke-all                                Sign out every remote connector
  mcp                                       MCP server over stdio (Claude Desktop / Claude Code)
  token create [name] | list | revoke <id>  Bearer tokens for the HTTP MCP endpoint
  guide [file]                              Write the Claude Project instructions (session scripts)
  import <files|folders>                    Import Kindle My Clippings.txt and/or Markdown notes
  export [--json file] [--md dir]           Export everything (JSON) and/or a Markdown vault
  backup [--dir d] [--keep 30]              Timestamped SQLite snapshot (safe while serving)
  reindex                                   (Re)compute embeddings for everything
  help

Environment: LOOM_PUBLIC_URL, LOOM_DB (default ${defaultDbPath()}), LOOM_DATA_DIR, LOOM_NO_EMBED=1 to disable semantic search.`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { port: { type: 'string' }, host: { type: 'string' }, 'public-url': { type: 'string' }, 'public-port': { type: 'string' } },
    allowPositionals: true,
    strict: false,
  });
  const loom = () => createLoom(process.env.LOOM_NO_EMBED ? { embedder: null } : {});

  switch (cmd) {
    case 'serve': {
      serve(loom(), {
        port: Number(values.port ?? process.env.PORT ?? 4317),
        host: String(values.host ?? process.env.HOST ?? '127.0.0.1'),
        publicUrl: (values['public-url'] as string | undefined) ?? process.env.LOOM_PUBLIC_URL,
        publicPort: Number(values['public-port'] ?? process.env.LOOM_PUBLIC_PORT ?? 4318),
      });
      break;
    }
    case 'set-password': {
      const l = loom();
      const pw = await readSecret('New Loom password (used to approve Claude connectors): ');
      const again = await readSecret('Repeat: ');
      if (pw !== again) throw new Error('Passwords did not match');
      setOwnerPassword(l, pw);
      console.log('Password set.');
      l.close();
      break;
    }
    case 'revoke-all': {
      const l = loom();
      console.log(`Revoked ${new LoomOAuthProvider(l).revokeAll()} OAuth tokens. Claude connectors must sign in again.`);
      l.close();
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
    case 'backup': {
      const l = loom();
      const dir = (rest[rest.indexOf('--dir') + 1] && rest.includes('--dir')) ? rest[rest.indexOf('--dir') + 1] : join(dirname(l.db.path), 'backups');
      const keep = rest.includes('--keep') ? Number(rest[rest.indexOf('--keep') + 1]) : 30;
      console.log(`Backed up to ${l.exporter.backup(dir, keep)} (keeping newest ${keep})`);
      l.close();
      break;
    }
    case 'export': {
      const l = loom();
      const jsonOut = rest.includes('--json') ? rest[rest.indexOf('--json') + 1] : null;
      const mdOut = rest.includes('--md') ? rest[rest.indexOf('--md') + 1] : null;
      if (!jsonOut && !mdOut) throw new Error('Usage: loom export [--json file.json] [--md dir]');
      if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify(l.exporter.json(), null, 1));
        console.log(`Wrote ${jsonOut}`);
      }
      if (mdOut) console.log(`Wrote ${l.exporter.markdownVault(mdOut).files} files to ${mdOut}`);
      l.close();
      break;
    }
    case 'import': {
      const l = loom();
      const files = rest.filter((f) => !f.startsWith('--'));
      if (!files.length) throw new Error('Usage: loom import <My Clippings.txt | note.md | folder> ...');
      const all: string[] = [];
      const walk = (p: string) => {
        if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
        else all.push(p);
      };
      files.forEach(walk);
      let created = 0, skipped = 0;
      for (const f of all) {
        const text = readFileSync(f, 'utf8');
        const r = f.toLowerCase().endsWith('.md')
          ? l.importer.markdown(text, { filename: basename(f) })
          : f.toLowerCase().endsWith('.txt')
            ? l.importer.kindle(text)
            : null;
        if (!r) continue;
        created += r.created;
        skipped += r.skipped;
        for (const s of r.sources) if (s.created) console.log(`  + source: ${s.title}`);
      }
      console.log(`Imported ${created} notes (${skipped} already present). Embeddings are computed on next \`loom serve\` or \`loom reindex\`.`);
      l.close();
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

let piped: string[] | null = null;

async function readSecret(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  if (!process.stdin.isTTY) {
    // Piped input (e.g. printf 'pw\npw\n' | loom set-password): read all lines once.
    if (!piped) {
      piped = [];
      for await (const line of createInterface({ input: process.stdin })) piped.push(line);
    }
    return piped.shift() ?? '';
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
