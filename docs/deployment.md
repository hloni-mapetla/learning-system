# Remote access: using Loom from Claude on the web and on your phone

Claude on the web and on mobile can reach Loom through a **custom connector**: an MCP server on a public HTTPS URL, protected by OAuth. Loom keeps your database on your Mac, so the setup is:

```
Claude (web/mobile) ──HTTPS──▶ tunnel (Cloudflare or Tailscale) ──▶ 127.0.0.1:4318 (Loom public listener: OAuth + /mcp only)
                                                                   127.0.0.1:4317 (web UI + REST API: never exposed)
```

**Limitation:** the connector only works while your Mac is awake and running `loom serve`. Keep the Mac plugged in and turn on *System Settings → Battery → Options → Prevent automatic sleeping when the display is off*, or run `caffeinate -s` (or use Amphetamine) while you need remote access.

## 1. Set the approval password

```bash
cd ~/code/learning-system
npm run loom -- set-password
```

When you add the connector, Claude opens a "Connect to Loom" page asking for this password. That page is the only thing that can grant access. To sign every connector out later (e.g. you lost a phone), run `npm run loom -- revoke-all`.

## 2. Get a stable public HTTPS URL

The URL must stay the same, because Claude stores it in the connector. Pick one of these options.

### Option A: Tailscale Funnel (no domain needed)

1. Install Tailscale (`brew install --cask tailscale`), sign in, and enable **Funnel** for your tailnet (admin console → Access controls; follow the prompt the first time you run the command).
2. Expose the public listener:
   ```bash
   tailscale funnel --bg 4318
   ```
3. Your URL is `https://<machine-name>.<tailnet>.ts.net`. Check it with `tailscale funnel status`.

### Option B: Cloudflare Tunnel (needs a domain on Cloudflare)

```bash
brew install cloudflared
cloudflared tunnel login                      # pick your domain
cloudflared tunnel create loom                # prints a tunnel UUID
cloudflared tunnel route dns loom loom.example.com
cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml   # then edit hostname, UUID, paths
sudo cloudflared service install              # runs the tunnel at boot (launchd)
```

Your URL is `https://loom.example.com`.

*For a quick test only:* `cloudflared tunnel --url http://127.0.0.1:4318` prints a random `trycloudflare.com` URL that changes on every run, so it isn't suitable for a saved connector.

## 3. Run Loom with the public URL

```bash
LOOM_PUBLIC_URL=https://loom.example.com npm run serve
# loom: web UI + API   http://127.0.0.1:4317
# loom: public MCP     http://127.0.0.1:4318  →  https://loom.example.com/mcp
```

To keep it running across logins, install the launchd agent:

```bash
cp deploy/com.loom.server.plist ~/Library/LaunchAgents/   # edit YOU, paths and LOOM_PUBLIC_URL first
launchctl load ~/Library/LaunchAgents/com.loom.server.plist
tail -f ~/.loom/server.log
```

Check it from outside: `curl https://loom.example.com/.well-known/oauth-authorization-server` should return JSON.

## 4. Add the connector in Claude

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `Loom`. URL: `https://loom.example.com/mcp` (note the `/mcp`).
3. Leave the OAuth Client ID/Secret fields empty; Loom supports dynamic client registration.
4. Click **Connect**. On the "Connect to Loom" page enter your password and click **Allow**.
5. In a chat, enable Loom from the tools menu. Connectors you add on the web also appear in the Claude mobile apps.

Then create a **Project** (e.g. "Study") and paste `docs/claude-project-guide.md` into its instructions (regenerate it with `npm run loom -- guide docs/claude-project-guide.md`). Start chats in that project with "daily review", "exam prep on …", "connect …", or paste highlights and say "process reading".

## Security model

- The public listener serves **only** OAuth endpoints and `/mcp`. The web UI and REST API live on the private listener (127.0.0.1:4317), which no tunnel should ever point at.
- OAuth 2.1 with PKCE and dynamic client registration. Access tokens last 1 hour; refresh tokens last 90 days and rotate on every use. Only SHA-256 hashes of tokens are stored.
- Approval needs your password (stored as a scrypt hash). Failed attempts are rate-limited to 10 per 15 minutes, and the SDK rate-limits the OAuth endpoints as well.
- Personal access tokens (`loom token create`) also work as bearer tokens for scripts and Claude Code. Revoke them with `loom token revoke <id>`.
- Anyone holding a valid token has full read/write access to your knowledge base, so treat tokens like passwords.
