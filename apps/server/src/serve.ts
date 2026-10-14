import express from 'express';
import type { Server } from 'node:http';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Loom } from '@loom/core';
import { buildApp } from './app.ts';
import { mountMcp } from './mcpHttp.ts';
import { approveRouter, LoomOAuthProvider } from './oauth.ts';

export interface ServeOptions {
  host: string;
  port: number;
  /** Public HTTPS URL of the tunnel (e.g. https://loom.example.com). Enables the public MCP listener. */
  publicUrl?: string;
  publicPort?: number;
}

/**
 * Two listeners, both on loopback:
 *  - private (default 4317): web UI, REST API, and /mcp with bearer tokens. Never expose this one.
 *  - public  (default 4318, only with publicUrl): /mcp + OAuth endpoints ONLY. Point the tunnel here.
 */
export function serve(loom: Loom, o: ServeOptions): { servers: Server[]; provider: LoomOAuthProvider } {
  const provider = new LoomOAuthProvider(loom);
  const servers: Server[] = [];

  const { app, scheduleEmbed } = buildApp(loom, {
    extend: (a) => mountMcp(a, loom, requireBearerAuth({ verifier: provider })),
  });
  servers.push(app.listen(o.port, o.host, () => console.log(`loom: web UI + API   http://${o.host}:${o.port}`)));

  if (o.publicUrl) {
    const port = o.publicPort ?? 4318;
    const pub = buildPublicApp(loom, provider, o.publicUrl);
    servers.push(pub.listen(port, '127.0.0.1', () => console.log(`loom: public MCP     http://127.0.0.1:${port}  →  ${new URL('/mcp', o.publicUrl).href}`)));
  }

  console.log(`loom: database       ${loom.db.path}`);
  if (loom.embeddings.reindexAll() || loom.embeddings.pending()) scheduleEmbed();
  return { servers, provider };
}

/** The internet-facing app: OAuth endpoints + /mcp only. No UI, no REST API. */
export function buildPublicApp(loom: Loom, provider: LoomOAuthProvider, publicUrl: string) {
  const base = new URL(publicUrl);
  const mcpUrl = new URL('/mcp', base);
  const pub = express();
  pub.disable('x-powered-by');
  pub.set('trust proxy', 'loopback');
  pub.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, resourceName: 'Loom', scopesSupported: ['loom'] }));
  pub.use(approveRouter(provider));
  pub.use('/mcp', express.json({ limit: '20mb' }));
  mountMcp(pub, loom, requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }));
  pub.get('/', (_req, res) => res.type('text').send(`Loom MCP endpoint. Add ${mcpUrl.href} as a custom connector in Claude.`));
  return pub;
}
