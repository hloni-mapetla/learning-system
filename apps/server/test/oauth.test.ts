import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { testLoom } from '../../../packages/core/test/helpers.ts';
import { buildPublicApp } from '../src/serve.ts';
import { LoomOAuthProvider, setOwnerPassword } from '../src/oauth.ts';
import { tokenStore } from '../src/tokens.ts';

const PORT = 43000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
let server: Server;
const loom = testLoom();

beforeAll(async () => {
  setOwnerPassword(loom, 'correct horse battery');
  const app = buildPublicApp(loom, new LoomOAuthProvider(loom), BASE);
  await new Promise<void>((r) => (server = app.listen(PORT, '127.0.0.1', () => r())));
});
afterAll(() => server.close());

const mcp = (token: string) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('remote MCP OAuth', () => {
  it('runs discovery → registration → password approval → PKCE token → MCP → refresh', async () => {
    // 1. Unauthenticated MCP points at the protected-resource metadata.
    const r401 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);

    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    expect(prm.resource).toBe(`${BASE}/mcp`);
    const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json() as any;
    expect(asm).toMatchObject({ issuer: `${BASE}/`, code_challenge_methods_supported: ['S256'] });

    // 2. Dynamic client registration.
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const client = await (
      await fetch(asm.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
      })
    ).json() as any;
    expect(client.client_id).toMatch(/^c_/);

    // 3. Authorize → password page.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL(asm.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${BASE}/mcp` }).forEach(([k, v]) => auth.searchParams.set(k, v));
    const page = await (await fetch(auth, { redirect: 'manual' })).text();
    expect(page).toContain('Connect to Loom');
    const requestId = /name="request_id" value="([0-9a-f]+)"/.exec(page)![1];

    const approve = (password: string) =>
      fetch(`${BASE}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: requestId, password, action: 'approve' }),
      });
    expect((await approve('wrong password!')).status).toBe(401);
    const ok = await approve('correct horse battery');
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get('state')).toBe('st8');
    const code = loc.searchParams.get('code')!;

    // 4. Token exchange with PKCE; codes are single-use.
    const tokenReq = (body: Record<string, string>) =>
      fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const badPkce = await tokenReq({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: client.client_id, redirect_uri: redirect });
    expect(badPkce.status).toBe(400);
    const tok = await (await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect })).json() as any;
    expect(tok).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    const reuse = await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect });
    expect(reuse.status).toBe(400);

    // 5. MCP works with the access token.
    const list = await (await mcp(tok.access_token)).json() as any;
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('get_due_cards');

    // 6. Refresh rotates the refresh token.
    const ref = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id })).json() as any;
    expect(ref.access_token).not.toBe(tok.access_token);
    expect((await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id })).status).toBe(400);
    expect((await mcp(ref.access_token)).status).toBe(200);

    // 7. Revoke-all signs everything out.
    new LoomOAuthProvider(loom).revokeAll();
    expect((await mcp(ref.access_token)).status).toBe(401);
  });

  it('accepts personal access tokens and rejects garbage', async () => {
    const { token } = tokenStore(loom).create('cli');
    expect((await mcp(token)).status).toBe(200);
    expect((await mcp('loom_nope')).status).toBe(401);
    expect((await mcp('la_nope')).status).toBe(401);
  });

  it('does not expose the REST API or UI publicly', async () => {
    expect((await fetch(`${BASE}/api/notes`)).status).toBe(404);
  });
});
