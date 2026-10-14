-- OAuth 2.1 authorization server state for the remote MCP connector (single user).
CREATE TABLE oauth_clients (
  client_id  TEXT PRIMARY KEY,
  info       TEXT NOT NULL, -- JSON OAuthClientInformationFull
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  resource       TEXT,
  expires_at     INTEGER NOT NULL -- epoch seconds
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id  TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_tokens_client ON oauth_tokens (client_id);
