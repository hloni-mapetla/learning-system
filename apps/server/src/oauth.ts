import express from 'express';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Loom } from '@loom/core';
import { tokenStore } from './tokens.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days
const CODE_TTL = 5 * 60;
const PASSWORD_KEY = 'owner_password';

// ---- owner password (scrypt) ----

export function setOwnerPassword(loom: Loom, password: string): void {
  if (password.length < 10) throw new Error('Use at least 10 characters.');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  loom.settings.setRaw(PASSWORD_KEY, { salt: salt.toString('hex'), hash: hash.toString('hex') });
}

export function hasOwnerPassword(loom: Loom): boolean {
  return !!loom.settings.getRaw(PASSWORD_KEY);
}

function checkOwnerPassword(loom: Loom, password: string): boolean {
  const stored = loom.settings.getRaw<{ salt: string; hash: string }>(PASSWORD_KEY);
  if (!stored) return false;
  const h = scryptSync(password, Buffer.from(stored.salt, 'hex'), 32);
  return timingSafeEqual(h, Buffer.from(stored.hash, 'hex'));
}

// ---- provider ----

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
}

/**
 * Single-user OAuth 2.1 authorization server (PKCE, dynamic client registration, refresh-token rotation).
 * "Authorize" shows a password page; the owner's password is set with `loom set-password`.
 * Personal access tokens from `loom token create` are accepted as bearer tokens too.
 */
export class LoomOAuthProvider implements OAuthServerProvider {
  readonly loom: Loom;
  readonly pending = new Map<string, Pending>();
  readonly #pats;

  constructor(loom: Loom) {
    this.loom = loom;
    this.#pats = tokenStore(loom);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.loom.db;
    return {
      getClient(clientId: string) {
        const r = db.get<{ info: string }>('SELECT info FROM oauth_clients WHERE client_id = ?', [clientId]);
        return r ? (JSON.parse(r.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client) {
        const full = {
          ...client,
          client_id: `c_${randomBytes(12).toString('hex')}`,
          client_id_issued_at: now(),
        } as OAuthClientInformationFull;
        db.run('INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)', [
          full.client_id,
          JSON.stringify(full),
          new Date().toISOString(),
        ]);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response): Promise<void> {
    for (const [k, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(k);
    const requestId = randomBytes(16).toString('hex');
    this.pending.set(requestId, { client, params, expires: Date.now() + 10 * 60_000 });
    res.status(200).type('html').send(loginPage({ requestId, clientName: client.client_name ?? client.client_id, ready: hasOwnerPassword(this.loom) }));
  }

  /** Called by the login form. Returns the redirect URL (success or error). */
  approve(requestId: string, password: string): { redirect?: string; error?: string } {
    const p = this.pending.get(requestId);
    if (!p || p.expires < Date.now()) return { error: 'This sign-in request expired. Start again from Claude.' };
    if (!checkOwnerPassword(this.loom, password)) return { error: 'Wrong password.' };
    this.pending.delete(requestId);
    const code = randomBytes(32).toString('base64url');
    this.loom.db.run(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sha256(code), p.client.client_id, p.params.redirectUri, p.params.codeChallenge, JSON.stringify(p.params.scopes ?? []),
        p.params.resource?.href ?? null, now() + CODE_TTL],
    );
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('code', code);
    if (p.params.state) url.searchParams.set('state', p.params.state);
    return { redirect: url.href };
  }

  deny(requestId: string): string | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    this.pending.delete(requestId);
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (p.params.state) url.searchParams.set('state', p.params.state);
    return url.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const r = this.loom.db.get<{ code_challenge: string; client_id: string }>('SELECT * FROM oauth_codes WHERE code_hash = ?', [sha256(code)]);
    if (!r || r.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return r.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const db = this.loom.db;
    const r = db.get<{ client_id: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }>(
      'SELECT * FROM oauth_codes WHERE code_hash = ?',
      [sha256(code)],
    );
    db.run('DELETE FROM oauth_codes WHERE code_hash = ? OR expires_at < ?', [sha256(code), now()]); // single use
    if (!r || r.client_id !== client.client_id || r.expires_at < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.#issue(client.client_id, JSON.parse(r.scopes), r.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const db = this.loom.db;
    const r = db.get<{ client_id: string; scopes: string; resource: string | null; expires_at: number }>(
      `SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`,
      [sha256(refreshToken)],
    );
    if (!r || r.client_id !== client.client_id || r.expires_at < now()) throw new InvalidGrantError('Invalid refresh token');
    db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [sha256(refreshToken)]); // rotate
    const granted: string[] = JSON.parse(r.scopes);
    return this.#issue(client.client_id, scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted, r.resource);
  }

  #issue(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const db = this.loom.db;
    const access = `la_${randomBytes(32).toString('base64url')}`;
    const refresh = `lr_${randomBytes(32).toString('base64url')}`;
    const created = new Date().toISOString();
    db.tx(() => {
      db.run('DELETE FROM oauth_tokens WHERE expires_at < ?', [now()]);
      db.run(`INSERT INTO oauth_tokens VALUES (?, 'access', ?, ?, ?, ?, ?)`, [sha256(access), clientId, JSON.stringify(scopes), resource, now() + ACCESS_TTL, created]);
      db.run(`INSERT INTO oauth_tokens VALUES (?, 'refresh', ?, ?, ?, ?, ?)`, [sha256(refresh), clientId, JSON.stringify(scopes), resource, now() + REFRESH_TTL, created]);
    });
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith('loom_')) {
      const pat = this.#pats.verify(token);
      if (!pat) throw new InvalidTokenError('Invalid token');
      // PATs don't expire (revoke with `loom token revoke`), but the SDK's bearer middleware requires an expiry.
      return { token, clientId: `pat:${pat.id}`, scopes: [], expiresAt: now() + 3600 };
    }
    const r = this.loom.db.get<{ client_id: string; scopes: string; resource: string | null; expires_at: number }>(
      `SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`,
      [sha256(token)],
    );
    if (!r || r.expires_at < now()) throw new InvalidTokenError('Invalid or expired token');
    return { token, clientId: r.client_id, scopes: JSON.parse(r.scopes), expiresAt: r.expires_at, resource: r.resource ? new URL(r.resource) : undefined };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: { token: string }): Promise<void> {
    this.loom.db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [sha256(req.token)]);
  }

  /** Revoke every OAuth grant (e.g. a lost phone). PATs are managed separately. */
  revokeAll(): number {
    const n = this.loom.db.run('DELETE FROM oauth_tokens').changes;
    this.loom.db.run('DELETE FROM oauth_codes');
    return n;
  }
}

// ---- login page + approve endpoint ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(o: { requestId: string; clientName: string; ready: boolean; error?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Loom</title><style>
:root{--bg:#f7f5f0;--panel:#fff;--ink:#23221f;--muted:#6d6a62;--line:#e2ded4;--accent:#2f6b62;--danger:#b0352f}
@media(prefers-color-scheme:dark){:root{--bg:#161716;--panel:#1e201f;--ink:#e8e6e1;--muted:#a19e96;--line:#2e312f;--accent:#6fb5a8;--danger:#e0716a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:360px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);font-size:14px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 12px;font-size:16px;background:transparent;color:var(--ink)}
.row{display:flex;gap:8px;margin-top:14px}button{flex:1;height:44px;border-radius:8px;border:1px solid var(--line);font-size:15px;font-weight:600;cursor:pointer;background:transparent;color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:var(--danger);font-size:14px;margin-bottom:10px}
</style></head><body><form method="post" action="/oauth/approve">
<h1>Connect to Loom</h1>
<p><b>${esc(o.clientName)}</b> wants full access to your notes, cards and tasks.</p>
${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
${o.ready ? `<input type="password" name="password" placeholder="Loom password" autofocus required autocomplete="current-password">` : `<div class="err">No password set. On the computer running Loom, run <code>loom set-password</code>, then try again.</div>`}
<input type="hidden" name="request_id" value="${esc(o.requestId)}">
<div class="row"><button type="submit" name="action" value="deny">Deny</button>${o.ready ? '<button class="primary" type="submit" name="action" value="approve">Allow</button>' : ''}</div>
</form></body></html>`;
}

/** POST /oauth/approve, with a simple brute-force limit. */
export function approveRouter(provider: LoomOAuthProvider) {
  const r = express.Router();
  const failures: number[] = [];
  r.post('/oauth/approve', express.urlencoded({ extended: false }), (req, res) => {
    const { request_id: requestId = '', password = '', action } = req.body ?? {};
    if (action === 'deny') {
      const url = provider.deny(requestId);
      return url ? res.redirect(302, url) : res.status(400).send('Unknown request');
    }
    const cutoff = Date.now() - 15 * 60_000;
    while (failures.length && failures[0] < cutoff) failures.shift();
    if (failures.length >= 10) return res.status(429).send('Too many attempts. Wait 15 minutes.');
    const out = provider.approve(requestId, password);
    if (out.redirect) return res.redirect(302, out.redirect);
    failures.push(Date.now());
    const pending = provider.pending.get(requestId);
    res.status(401).type('html').send(
      loginPage({ requestId, clientName: pending?.client.client_name ?? 'Claude', ready: true, error: out.error }),
    );
  });
  return r;
}
