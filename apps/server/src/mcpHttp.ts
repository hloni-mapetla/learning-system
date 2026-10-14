import type express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Loom } from '@loom/core';
import { createMcpServer } from '@loom/mcp';

/**
 * Streamable HTTP MCP endpoint, stateless: each POST gets a fresh server+transport over the shared Loom
 * instance (cheap; all state lives in SQLite). `auth` runs first and must reject unauthenticated requests.
 */
export function mountMcp(app: express.Express, loom: Loom, auth: express.RequestHandler, path = '/mcp') {
  app.post(path, auth, async (req, res) => {
    const server = createMcpServer(loom);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless server: no server-initiated streams or sessions to delete.
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get(path, notAllowed);
  app.delete(path, notAllowed);
}
