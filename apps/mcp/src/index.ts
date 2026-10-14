import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Loom } from '@loom/core';
import { registerTools } from './tools.ts';
import { PROMPTS, SERVER_INSTRUCTIONS } from './prompts.ts';

export { PROMPTS, SERVER_INSTRUCTIONS, renderGuide } from './prompts.ts';

/** Build an MCP server over a Loom instance. Transports (stdio / HTTP) are attached by the caller. */
export function createMcpServer(loom: Loom): McpServer {
  const server = new McpServer(
    { name: 'loom', title: 'Loom — personal learning system', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  );
  registerTools(server, loom);
  for (const p of PROMPTS) {
    const argsSchema = Object.fromEntries(
      p.args.map((a) => [a.name, a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description)]),
    );
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema }, (args: Record<string, string | undefined>) => ({
      messages: [{ role: 'user', content: { type: 'text', text: p.render(args) } }],
    }));
  }
  return server;
}
