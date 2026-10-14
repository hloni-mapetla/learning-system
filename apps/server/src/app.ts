import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Loom } from '@loom/core';
import { apiRouter } from './api.ts';

const WEB_DIST = join(import.meta.dirname, '../../web/dist');

export interface AppOptions {
  /** Hook to mount additional routes (MCP, OAuth) before the SPA fallback. */
  extend?: (app: express.Express) => void;
}

export function buildApp(loom: Loom, opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // Live updates: tell open UIs whenever the database changes, including writes from the stdio MCP process.
  const clients = new Set<express.Response>();
  let lastVersion = loom.db.dataVersion();
  const broadcast = () => {
    for (const c of clients) c.write(`event: change\ndata: ${Date.now()}\n\n`);
  };
  const timer = setInterval(() => {
    const v = loom.db.dataVersion();
    if (v !== lastVersion) {
      lastVersion = v;
      broadcast();
    }
  }, 1000);
  timer.unref();

  // Background embedding: debounce after writes.
  let pending: NodeJS.Timeout | null = null;
  const scheduleEmbed = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      loom.embeddings.drain().then((n) => n && broadcast(), (e) => console.error('[embed]', e));
    }, 400);
  };
  loom.ctx.onIndexNeeded.push(scheduleEmbed);

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });
  app.use('/api', apiRouter(loom, broadcast));
  app.use('/mcp', express.json({ limit: '20mb' }));

  opts.extend?.(app);

  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|mcp|oauth|\.well-known).*/, (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));
  }
  return { app, broadcast, scheduleEmbed };
}
