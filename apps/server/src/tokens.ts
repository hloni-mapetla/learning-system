import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Loom } from '@loom/core';

interface StoredToken {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

const KEY = 'api_tokens';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Personal access tokens for the HTTP MCP endpoint (Claude Code, scripts). Only hashes are stored. */
export function tokenStore(loom: Loom) {
  const all = () => loom.settings.getRaw<StoredToken[]>(KEY) ?? [];
  return {
    list: () => all().map(({ hash: _h, ...t }) => t),
    create(name: string): { id: string; token: string } {
      const token = `loom_${randomBytes(24).toString('base64url')}`;
      const id = randomBytes(4).toString('hex');
      loom.settings.setRaw(KEY, [...all(), { id, name, hash: sha256(token), createdAt: new Date().toISOString() }]);
      return { id, token };
    },
    revoke(id: string): boolean {
      const cur = all();
      const next = cur.filter((t) => t.id !== id);
      loom.settings.setRaw(KEY, next);
      return next.length !== cur.length;
    },
    verify(token: string): StoredToken | null {
      const h = Buffer.from(sha256(token), 'hex');
      for (const t of all()) {
        if (timingSafeEqual(h, Buffer.from(t.hash, 'hex'))) return t;
      }
      return null;
    },
  };
}
