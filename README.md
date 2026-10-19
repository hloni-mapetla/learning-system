# Loom

A local-first personal learning system: a **knowledge store** (sources, notes, highlights, atomic concepts and claims, typed links, a graph), **FSRS spaced repetition** (basic, cloze, open-ended and cross-source synthesis cards) and a **learning-aware to-do list**, all in one SQLite file. You can drive it from a fast keyboard-first web UI, or **through Claude**: an MCP server lets Claude quiz you, grade your answers, schedule reviews, and propose notes, cards and connections across everything you've read.

Loom never calls the Anthropic API itself. Claude does the thinking through MCP tools, in your own Claude account.

```
                      ┌───────────────── @loom/core (TypeScript) ─────────────────┐
 Web UI (React) ─REST─┤ sources · notes · wikilinks · typed links · tags · search  │
 Claude Desktop/Code ─┤ FSRS cards & reviews · tasks · graph · connections · stats │── SQLite (~/.loom/loom.db)
 Claude web/mobile ───┤ imports · exports · local embeddings (bge-small, ONNX)     │
   (OAuth, tunnel)    └───────────────────────────────────────────────────────────┘
```

---

## Contents

1. [Setup](#setup)
2. [Using the web UI](#using-the-web-ui)
3. [Connecting to Claude](#connecting-to-claude) (Claude Code, Claude Desktop, claude.ai web and mobile)
4. [Session styles](#session-styles): daily review, exam prep, connect, process reading
5. [MCP tools](#mcp-tools)
6. [Data, backup and export](#data-backup-and-export)
7. [Remote endpoint deployment](#remote-endpoint-deployment)
8. [Development](#development)
9. [Design notes](#design-notes)

---

## Setup

Requirements: **macOS or Linux, Node.js ≥ 24** (developed on Node 26; Loom uses the built-in `node:sqlite` and runs TypeScript directly, so there's no build step for the server).

```bash
cd ~/code/learning-system
npm install
npm run build        # builds the web UI into apps/web/dist
npm run serve        # → http://127.0.0.1:4317
```

On first start Loom creates `~/.loom/loom.db` and downloads the embedding model (`Xenova/bge-small-en-v1.5`, about 130 MB) into `~/.loom/models`. After that, semantic search runs fully offline.

Optional: make the `loom` command global with `npm link`. Otherwise use `npm run loom -- <command>`.

| Command | What it does |
|---|---|
| `loom serve` | Web UI + REST API + local HTTP MCP (`--port 4317`; add `--public-url` for remote access) |
| `loom mcp` | MCP server over stdio (Claude Desktop / Claude Code) |
| `loom token create <name>` · `list` · `revoke <id>` | Bearer tokens for the HTTP MCP endpoint |
| `loom set-password` / `loom revoke-all` | Password for approving remote connectors / sign every connector out |
| `loom import <My Clippings.txt \| notes.md \| folder>…` | Import Kindle clippings and Markdown |
| `loom export --json out.json --md ./vault` | Full JSON export and/or an Obsidian-compatible Markdown vault |
| `loom backup [--dir d] [--keep 30]` | Timestamped SQLite snapshot, safe while the server runs |
| `loom reindex` | Recompute embeddings (e.g. after changing model) |
| `loom guide [file]` | Print or write the Claude Project instructions |

Environment variables: `LOOM_DB` (database path), `LOOM_DATA_DIR` (default `~/.loom`), `LOOM_PUBLIC_URL`, `LOOM_NO_EMBED=1` (disables semantic search).

---

## Using the web UI

Open http://127.0.0.1:4317. The UI is built for the keyboard; press <kbd>?</kbd> anywhere for the full list.

| Keys | Action |
|---|---|
| <kbd>⌘K</kbd> | Command palette with search (hybrid keyword + semantic) |
| <kbd>g</kbd> then <kbd>t r s n c g i m</kbd> | Go to Today / Review / Sources / Notes / Cards / Graph / Stats / Import |
| <kbd>/</kbd> | Search page (switch between Hybrid, Keyword and Semantic) |
| <kbd>c</kbd> | New note |
| <kbd>j</kbd> <kbd>k</kbd> <kbd>↵</kbd> | Move and open in any list; <kbd>x</kbd> completes a task on Today |
| <kbd>a</kbd> | Add: a task (Today), a source (Sources), a highlight (on a source) |
| <kbd>e</kbd> / <kbd>esc</kbd> | Edit / stop editing a note. `[[` autocompletes links; select text and press <kbd>⌘⇧C</kbd> to make a cloze |
| <kbd>C</kbd> / <kbd>L</kbd> | On a note: new card / new typed link |
| <kbd>r</kbd>, <kbd>⌘↵</kbd>, <kbd>s</kbd>, <kbd>n</kbd> / <kbd>N</kbd> | On a source: recall from memory, save it, skip the recall, draft a concept / claim note |
| <kbd>space</kbd>, <kbd>1</kbd>–<kbd>4</kbd>, <kbd>u</kbd>, <kbd>!</kbd> | Review: reveal, Again/Hard/Good/Easy, undo, suspend |

The main pieces:

- **Today:** a computed "Review N due cards" task, overdue and today's tasks, upcoming and someday tasks, and your reading queue ordered by priority. Completing a *read* task asks you what you remember (a blank-page recall) before you look at any highlights, or reminds you tomorrow.
- **Sources:** books, articles, papers, videos, lectures and podcasts, each with status (queued, reading, done, abandoned), priority 1–5, tags, highlights and notes (ordered by page or location), tasks, and possible connections.
- **Recall first:** a source with highlights and no recall opens with a *Recall first* box, and its highlights stay hidden until you've written what you remember (or pressed <kbd>s</kbd> to skip). After the recall you draft the key ideas yourself as concept and claim notes. Each source records how it was processed (*recall first* or *highlights first*) so you can later compare which works better for you. Expect the first 2–3 weeks to feel harder than rereading; that's the effort doing its job.
- **Authorship:** notes and sources record who wrote them. Notes Claude drafted are marked *by Claude* and imported quotes *imported*; your own work is unmarked. You can correct it on a note's properties.
- **Notes:** Markdown with `[[wikilinks]]` (links to notes that don't exist yet show in orange and connect automatically once the note is created), backlinks, typed links (*supports, contradicts, example of, prerequisite of, related*), and cards. Kinds are `note`, `highlight`, `concept`, `claim`, `summary`, `recall` (a blank-page recall of a source) and `explanation` (you explaining a concept in your own words); concepts and claims are your atomic ideas.
- **Cloze from notes:** write `{{c1::hidden text}}` (or `{{c1::answer::hint}}`) in any note and Loom keeps a cloze card per deletion in sync. Editing the note updates the card without losing its review history.
- **Graph:** global or local (open it from a note), with edges colored by relationship type and notes clustered around their source.
- **Stats:** retention against your target, reviews per day, a 30-day due forecast, streak, weakest topics, and mastery per source. You can also change the target retention and new cards per day here.
- **Import & export:** Kindle *My Clippings.txt* (pick which books), Markdown files, pasted highlights, JSON or Markdown export, and an on-demand backup.

The UI updates live when Claude changes something over MCP.

---

## Connecting to Claude

### Claude Code (stdio)

```bash
claude mcp add loom --scope user -- node ~/code/learning-system/apps/server/src/cli.ts mcp
```

Then, in any Claude Code session: `/mcp__loom__daily_review`, `/mcp__loom__exam_prep cognitive-biases`, or just ask ("quiz me on my due cards").

> Claude Code passes only the **first word** of a slash-command argument. Use a single word or a tag (`cognitive-biases`), or put the full phrase in the rest of your message; the prompts tell Claude to recover it.

### Claude Desktop (stdio)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "loom": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOU/code/learning-system/apps/server/src/cli.ts", "mcp"]
    }
  }
}
```

Use absolute paths, because Claude Desktop doesn't inherit your shell's `PATH`. Restart Claude Desktop. The four session styles appear under the **+** menu as prompts.

### Claude Code over HTTP (optional)

While `loom serve` is running:

```bash
npm run loom -- token create claude-code      # copy the loom_… token
claude mcp add --transport http loom-http http://127.0.0.1:4317/mcp --header "Authorization: Bearer loom_…"
```

### Claude on the web and mobile (custom connector)

This needs a public HTTPS URL that reaches your Mac. The full walkthrough is in [docs/deployment.md](docs/deployment.md). In short:

```bash
npm run loom -- set-password                     # the password you'll type when Claude connects
tailscale funnel --bg 4318                       # or a Cloudflare named tunnel → https://loom.example.com
LOOM_PUBLIC_URL=https://<host> npm run serve     # opens the MCP-only public listener on 4318
```

Then go to claude.ai → **Settings → Connectors → Add custom connector**, enter `https://<host>/mcp`, click **Connect**, and approve with your password. The connector also works in the Claude iOS and Android apps.

### A Claude Project for studying

Create a Project (e.g. "Study"), enable the Loom connector, and paste [docs/claude-project-guide.md](docs/claude-project-guide.md) into its instructions. That file is generated from the same source as the MCP prompts (`loom guide`), so they never disagree. Chats in the Project then understand "daily review", "exam prep on …", "connect …" and "process reading". This route works everywhere, including on mobile, where MCP prompts aren't shown.

---

## Session styles

| Style | What Claude does |
|---|---|
| **Daily review** | Fetches due cards and asks one at a time without revealing the answer. It asks a follow-up when your answer is shaky, grades against the card and its rubric, maps the result to an FSRS rating (*again, hard, good, easy*) and records it with a one-line assessment. It undoes a rating if you dispute it, and finishes with a summary of your weak spots. |
| **Exam prep on X** | Uses `get_study_context` to gather your notes, sources, weakest cards and recent failures on the topic. It asks about 60% recall and 40% synthesis questions, probes with Socratic follow-ups, records reviews for existing cards, and proposes new cards for the gaps. |
| **Connect** | Takes a note, runs `find_connections` (unlinked semantic neighbours from *other* sources), judges each candidate, and proposes typed links with rationales plus synthesis cards. It saves only what you approve. |
| **Process reading** | Generation-first. It imports any highlights silently, then asks what you remember *before* showing them, and saves your recall word for word. It compares the recall with the highlights and tells you what you missed and got wrong, sometimes asking you to retrieve a miss from a cue first. Then **you** draft the 3–7 concept and claim notes and Claude critiques them for accuracy, one idea per note, the missing *why* and connections (you name connections first). Cards follow, with your misses first. Say "suggest for me" if you want Claude to draft, and those notes are marked as Claude's. |

Ratings use this rubric: **again** = not recalled or wrong (or only after the answer was given); **hard** = core idea with a significant gap, or needed a hint; **good** = correct and essentially complete; **easy** = instant, complete and confident. When a rating is borderline, Claude chooses the lower one.

---

## MCP tools

| Area | Tools |
|---|---|
| Review | `get_due_cards(limit, topic?)`, `record_review(card_id, rating, notes?)`, `undo_review`, `get_card`, `get_review_stats` |
| Read | `search_knowledge(query, semantic=true)`, `get_note`, `get_source`, `list_sources`, `get_related(id)`, `find_connections(id \| topic)`, `get_study_context(topic)`, `list_tags` |
| Write | `create_source`, `update_source`, `create_note(authored_by)`, `update_note`, `create_card`, `update_card`, `create_link`, `import_highlights` |
| Recall first | `start_recall(source_id)`, `save_recall(source_id, text)`, `skip_recall`, `get_recall_review(source_id)` (recall next to highlights, with a similarity hint per highlight) |
| Tasks | `list_tasks(view)` (today, upcoming, all_open, done, reading_queue), `create_task`, `complete_task`, `update_task` |

Prompts: `daily_review`, `exam_prep`, `connect`, `process_reading`.

Notes on behavior:
- Read tools carry `readOnlyHint`; write tools are annotated as writes, so clients can ask before running them.
- Topics can be a tag (`psychology` also matches `psychology/heuristics`), a source title, or free text. Free text is matched semantically.
- Claude follows a "you generate first" rule: it asks for your recall, draft or guess before offering its own, and won't show a source's highlights until you've done a recall. This is in the server instructions, so it applies even when you just say "process reading" in a chat without the prompt.
- Cards, notes and sources Claude creates are marked `created_by: claude` (`create_note` takes `authored_by: "user"` only when saving your own words verbatim). Reviews it grades are logged with `grader: claude` and its assessment. Claude's cards and notes are labelled in the UI; review history is in the JSON export.

---

## Data, backup and export

Everything lives in **one SQLite file**, `~/.loom/loom.db` (WAL mode, so the web server and a stdio MCP process can use it at the same time). Model files are in `~/.loom/models`, backups in `~/.loom/backups` and Markdown exports in `~/.loom/exports`.

- **Backup:** `npm run loom -- backup` writes `~/.loom/backups/loom-<timestamp>.db` with `VACUUM INTO`, a consistent snapshot even while serving, and keeps the newest 30. For nightly backups, edit and load `deploy/com.loom.backup.plist`:
  ```bash
  cp deploy/com.loom.backup.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.loom.backup.plist
  ```
  Put `--dir` on a synced or external drive (iCloud Drive, Dropbox, a USB disk) for off-machine copies.
- **Upgrades:** when a new Loom version changes the database schema, Loom first copies the database to `~/.loom/backups/pre-migration-v<old>-to-v<new>-<timestamp>.db` and prints that path. The upgrade runs in one transaction and never rewrites cards' scheduling or review history.
- **Restore:** stop Loom, then `cp ~/.loom/backups/loom-<timestamp>.db ~/.loom/loom.db`.
- **Export:** `loom export --json loom.json --md ~/Documents/loom-vault`. The JSON contains every table (review history included; the password hash and tokens are excluded). The vault has one folder per source, YAML frontmatter, intact `[[wikilinks]]`, typed links as lists and cards in `_cards.md`, and it opens directly in Obsidian.

---

## Remote endpoint deployment

See **[docs/deployment.md](docs/deployment.md)**. Summary:

- `loom serve --public-url https://…` opens a second loopback listener on port **4318** that serves **only** OAuth and `/mcp`. Point your tunnel at 4318 and never at 4317 (the UI and REST API).
- Tunnel options: **Tailscale Funnel** (`tailscale funnel --bg 4318`, no domain needed) or a **Cloudflare named tunnel** (`deploy/cloudflared-config.yml`).
- Authentication is OAuth 2.1 with PKCE and dynamic client registration. You approve each new connector with your password (`loom set-password`). Access tokens last 1 hour; refresh tokens last 90 days and rotate on use. `loom revoke-all` signs everything out.
- Run at login with `deploy/com.loom.server.plist`. The connector only works while the Mac is awake.

---

## Development

```bash
npm test             # vitest: core services, FSRS scheduling, importers, MCP tools (in-memory client), OAuth flow
npm run typecheck
npm run dev          # API on :4317 (auto-restarts) + Vite dev server with HMR on :5173
```

```
packages/core/       the data layer; ALL logic lives here
  src/db.ts            node:sqlite wrapper (statement cache, nested tx, migrations)
  src/migrations/      plain SQL (schema, FTS5 triggers, OAuth tables)
  src/services/        sources, notes, links, tags, cards, review (FSRS), tasks, search, embeddings,
                       related/connections, study context, graph, stats, importer, exporter
  src/importers/       Kindle My Clippings, Markdown frontmatter, pasted highlights
apps/mcp/            MCP tools, prompts (+ guide renderer), stdio runner
apps/server/         Express: REST API, HTTP MCP, OAuth provider, CLI
apps/web/            React + Vite + TanStack Router/Query + CodeMirror 6 + Cytoscape + Tailwind
docs/                deployment.md, claude-project-guide.md (generated)
deploy/              launchd and cloudflared templates
```

The REST routes and MCP tools are both thin wrappers over `@loom/core`. To add a feature, write the service in core, then expose it in `apps/server/src/api.ts` and/or `apps/mcp/src/tools.ts`.

---

## Design notes

- **FSRS** via `ts-fsrs` (FSRS-6), with target retention 0.9 by default, learning steps of 1 m and 10 m, a 10 m relearning step, interval fuzz, and a 20-minute look-ahead for learning steps so sessions keep moving. Every review stores a snapshot of the card's previous state, which makes undo exact. New cards per day are capped (default 20).
- **Search:** FTS5 (porter stemming, prefix matching, bm25) plus local `bge-small-en-v1.5` embeddings over paragraph chunks, scored with brute-force cosine and fused with reciprocal rank fusion. Embedding runs in the background after each save and only re-embeds chunks that changed. At personal scale (up to roughly 100k chunks) brute force takes milliseconds and needs no native extension.
- **Cross-source connections:** "same source" means the same `source_id` (a standalone note is its own source). `find_connections` returns only unlinked neighbours from other sources, and a synthesis card must reference at least two distinct sources.
- **Why React + Vite:** CodeMirror 6 (the best Markdown editor for the web, with autocomplete hooks for `[[`), Cytoscape for graphs, and TanStack Query for cache invalidation when Claude writes over MCP. The ecosystem fit outweighed the smaller bundles of Svelte or Solid. Heavy pieces (the editor and the graph) load lazily.
- **Concepts and claims are notes with a `kind`**, so they get wikilinks, search, embeddings and the graph without separate code paths.
- **Generation first:** Loom is shaped around how learning works (retrieval, spacing, elaboration, interleaving, and generating before checking). [docs/learning-audit.md](docs/learning-audit.md) maps each principle to the code and lays out the phased changes. Recall-first processing (Phase A) is in; interleaved review, why/how cards and *Explain it*, prerequisite awareness, spaced exam plans, confidence calibration, production stats and the recall-first experiment follow.
- **Safe schema upgrades:** migrations are plain SQL run with foreign keys off (so rebuilding a table can't cascade-delete cards or review history), checked with `foreign_key_check` before commit, and preceded by an automatic backup.
