# Learning audit: Loom against nine evidence-based principles

Status: **draft for review**. Nothing here is implemented yet.
Scope: everything in the repo at commit `81931c1`, read from the code rather than the README.

---

## 0. Summary

**What Loom already does well.**
- FSRS spacing with a capped intake of new cards.
- Reviews that hide the answer until reveal.
- Rubric grading by Claude, where a hint caps the rating at *hard* and borderline answers get the lower rating.
- Synthesis cards that span sources.

**Where the design inverts the principles.** Most of it is in the *reading → knowledge* pipeline and in default orderings, not in the scheduler:

1. **Process reading has Claude do the generating.** Claude writes the concept notes "in my own words" and proposes every link (`apps/mcp/src/prompts.ts:94`, `:78`).
2. **Every path out of finishing a book leads to highlight capture.** This covers the task follow-up, the Today box, the source page and the Import page.
3. **The review queue is blocked, not interleaved.** Cards are ordered by due date and new cards by creation order, so cards from one note or source arrive back-to-back, cloze siblings included.
4. **The data model doesn't record who authored a note.** That makes "my own production" unmeasurable today.
5. **Nothing reads `prerequisite_of` links, confidence, or method,** so principles 5, 7 and H have nothing to stand on.

**Two things to know before any migration:**
- `node:sqlite` turns **foreign keys on by default** (verified: `PRAGMA foreign_keys` → 1). A naive table rebuild of `notes` or `cards` would cascade-delete cards and **review history**. §3 explains how the migration avoids this.
- Your live DB (`~/.loom/loom.db`) has real rows: 2 sources, 1 note and 1 review log. Migrations must be tested against a copy of it.

**README drift found while auditing:**
- README:175 says reviews graded by Claude are "visible in the UI". They aren't: `/api/cards/:id` returns `history`, but no page renders `grader` or the assessment.
- README:175 also implies Claude-created content is marked. That's only true for cards and links. Notes and sources have no `created_by` column (`001_init.sql:34-47`), so notes Claude writes look like yours.
- Everything else in the README matched the code.

---

## 1. Principle by principle

Legend: ✅ supports · ⚠️ partial or weak · ❌ works against

### 1. Retrieval beats review

**Supports**
- ✅ Review shows `prompt` only, with the answer behind an explicit reveal (`apps/web/src/pages/Review.tsx:151-179`).
- ✅ The MCP prompt forbids revealing the answer, rubric or hidden text first (`prompts.ts:41`). `cardForClaude` labels the answer "for grading only" (`apps/mcp/src/tools.ts:26-43`).
- ✅ Cloze, basic, open and synthesis are all recall formats; none is multiple choice.

**Partial**
- ⚠️ In the UI, open and synthesis cards say "Answer out loud or on paper" (`Review.tsx:156-158`). Nothing captures an attempt, so "I sort of knew it" passes as recall.
- ⚠️ The cloze prompt shows the whole surrounding paragraph (`cards.ts:285`, `clozeContext`). That's fine for facts, but long contexts become recognition cues.

**Works against**
- ❌ The source page *is* the highlight list (`SourceDetail.tsx:60-103`). Re-exposure is the default way to "engage" with a book.
- ❌ After an import, the only nudge is "ask Claude to process reading" (`Import.tsx:25`), and that flow then rereads the highlights for you.

### 2. Spacing beats massing

**Supports**
- ✅ FSRS-6 with desired retention 0.9, fuzz on, and short-term steps (`services/review.ts:50-61`, `settings.ts:16-24`).
- ✅ The new-card quota (20/day) is counted from logs, so it can't be bypassed by reloading (`review.ts:63-68, 99-109`).
- ✅ The daily review task is virtual and recomputed (`tasks.ts:118-139`), so stale "review" rows don't pile up.

**Partial**
- ⚠️ Learn-ahead of 20 min plus steps of 1m/10m means a failed card returns within the same session (`settings.ts:20-22`). That's standard and acceptable, but it's the only intentional massing.

**Works against**
- ❌ Exam prep is one 12-question session (`prompts.ts:54-67`). There's no notion of a date, and no plan, so the tool's shape invites cramming the night before.

### 3. Elaboration ("why?", "how does this connect?")

**Supports**
- ✅ Typed links with rationale (`001_init.sql:55-72`, `links.ts`). Synthesis cards require refs from 2 or more sources (`cards.ts:145-153`).
- ✅ Exam prep includes one Socratic follow-up ("why?", "what would X say?") before grading synthesis answers (`prompts.ts:63`).

**Partial**
- ⚠️ No card format asks for a *mechanism* or a *connection* specifically. Open cards are free-form, and the rubric guidance only says "grade the reasoning" (`prompts.ts:17`).

**Works against**
- ❌ The note page shows `SimilarPanel` suggestions immediately (`NoteDetail.tsx:235`, `SourceDetail.tsx:146`). The connection is handed to you before you've tried to make one.
- ❌ The `connect` session has Claude find candidates, judge them and propose every link (`prompts.ts:76-81`). You approve rather than generate.

### 4. Interleaving

**Works against**
- ❌ `due()` orders learning by `due`, reviews by `due` and new cards by `created_at, rowid` (`review.ts:96-106`).
  - Cards created together, such as the cards from one process-reading batch, get similar due dates and arrive as a block.
  - New cards are strictly blocked by creation, so one book at a time.
- ❌ Cloze siblings (c1, c2 … from one note) are inserted consecutively (`cards.ts:186-190`, `:284-292`) and reviewed back-to-back. Each one cues the others, which is interference rather than discrimination.
- ❌ The UI topic filter (`Review.tsx:127-130`) and `get_due_cards(topic)` can only narrow the queue to a single topic. There's no "mix these three".
- ❌ Nothing generates discrimination ("which idea applies here?") questions. `contradicts` and `related` links exist but are never used for practice.

### 5. Foundations

**Partial**
- ⚠️ `prerequisite_of` exists as a link type (`types.ts:6`, `LinkForm.tsx`) and is drawn in the graph (`graph.ts:54-57`).

**Works against**
- ❌ Nothing reads `prerequisite_of`. Not review, `study.context` (`study.ts:22-93`), stats, or the order new cards are introduced in.
  - A failed card's weak foundation is invisible.
  - New cards for an advanced idea can be introduced before cards for the idea it builds on.

### 6. Self-explanation

**Partial**
- ⚠️ "No lectures unless I ask *explain*" (`prompts.ts:47`) makes *Claude* the explainer.
- ⚠️ There is no session where you explain and Claude probes, and no note kind to keep your explanations.

### 7. Desirable difficulty and fluency illusions

**Supports**
- ✅ Grading rubric: a hint caps the rating at *hard*, borderline answers take the lower rating, and "I don't know" is rated *again* (`prompts.ts:12-17, 43-46`).

**Works against**
- ❌ In the UI, `Enter` means "reveal, then Good" (`Review.tsx:95`). Two taps of `Enter` give a Good rating without any judgment, which is the most fluent path through a card.
- ❌ `o` (open source note) works *before* reveal (`Review.tsx:104-107`), so you can peek.
- ❌ No confidence is captured, so overconfidence can't be detected (`review_logs`, `001_init.sql:123-142`).
- ❌ Highlights come first on the source page, and the capture box is the default `a` action (`SourceDetail.tsx:23, 63`).

### 8. Generate before you check

This is the biggest conflict.

**Works against**
- ❌ `process_reading` saves highlights first, then *Claude* proposes 3–7 concept and claim notes "in my own words", and cards and links (`prompts.ts:88-97`). You approve a list.
- ❌ `SERVER_INSTRUCTIONS` sets the default for every session to "propose new notes, cards and links first and save after approval" (`prompts.ts:9`). Claude generates by default.
- ❌ The read-task follow-up is `capture_highlights` (`tasks.ts:28-32, 91-99`), surfaced in `Today.tsx:76-97` and `SourceDetail.tsx:139`.
- ❌ `create_note` has no authorship field (`tools.ts:410-456`). Your drafts and Claude's are indistinguishable once saved.

**Supports**
- ✅ You can write cards and notes in the UI (`CardForm.tsx`, `Editor.tsx`). The paths exist; they just aren't the default.

### 9. Feedback at the edge of ability

**Supports**
- ✅ FSRS targets about 90% recall at review time, which is a sensible "edge".
- ✅ Claude gives immediate, specific feedback: what you got right and what was missing (`prompts.ts:44`).
- ✅ `get_study_context` surfaces the weakest cards by retrievability (`study.ts:30-33`).
- ✅ Exam prep starts easier and escalates (`prompts.ts:62`).

**Partial**
- ⚠️ Nothing adapts *within* a daily session. A run of *easy* answers doesn't escalate to why/how questions, and a run of *again* answers doesn't step down to prerequisites.
- ⚠️ Stats don't say whether the target retention is too easy or too hard for you.

---

## 2. Proposed changes, in priority order

Each phase below ends with `npm test` and `npm run typecheck` passing, a commit and a short summary. Phases follow your A–H order, with two adjustments:
- **Authorship (`created_by` on notes) moves into Phase A.** A's critique flow and G's ratio both need it.
- **The safe-migration machinery is Phase 0.** Everything after depends on it.

### Phase 0: safe migrations (prerequisite, small)

- `db.ts` `migrate()` currently runs each file in a transaction with foreign keys **on**. Change it to:
  1. Take an automatic `VACUUM INTO ~/.loom/backups/pre-migration-<version>-<ts>.db` when the DB has data.
  2. Run `PRAGMA foreign_keys = OFF`, *outside* the transaction (it is a no-op inside one).
  3. Run the migration file in a transaction.
  4. Run `PRAGMA foreign_key_check`, and abort and roll back if it returns rows.
  5. Run `PRAGMA foreign_keys = ON`.
- Add a test fixture: a v2 DB with cards, cloze cards, review logs, links, tags, tasks and FTS rows, migrated to latest. The test asserts that the row counts and every FSRS column of every card are identical, that `review_logs` is byte-identical, and that FTS search still finds the old notes.

### Phase A: generation-first process reading (principles 1, 7, 8)

**Core**

- **New note kinds `recall` and `explanation`, and `notes.created_by`** (`user` | `claude`, plus `system` for imports).
  - A `recall` note is a verbatim free-text "what do I remember" for a source, timestamped by `created_at`.
  - `explanation` is used in Phase C.
- **New `services/processing.ts`:**
  - `startRecall(sourceId)`: returns whether a recall exists yet, the number of highlights (count only, no text) and the recall prompt.
  - `saveRecall(sourceId, text, {actor})`: creates the `recall` note, sets `sources.method = 'recall_first'` if no recall preceded it, and moves the status from queued to reading if needed.
  - `recallReview(sourceId)`: returns the recall text(s), the highlights and your existing concept and claim notes for that source. Claude uses this to report **missed** and **wrong** items. The service also computes a cheap overlap hint per highlight (semantic similarity to the recall chunks, when embeddings are on) so Claude can prioritise. Claude still makes the judgment.
  - `skipRecall(sourceId)`: an explicit opt-out. It sets `method = 'highlights_first'` so the experiment in H stays honest.
- **Highlight visibility.**
  - `sourceDetail` gains `recallState: 'none' | 'done' | 'skipped'`.
  - The **UI hides highlight text until the recall is done or skipped.** The API doesn't hide it, because Claude needs it for the comparison; see the MCP rules below.
- **Task follow-up.**
  - `tasks.complete` on a `read` task returns `followUp.action = 'blank_page_recall'`, replacing `capture_highlights`. Its message is roughly "Before you look at anything: what do you remember?"
  - The "remind me tomorrow" task becomes kind `process_highlights` with the title "Recall & process: X". The kind keeps its name and gets a new label, so no tasks rebuild is needed.

**MCP**

- **New tools:**
  - `start_recall(source_id)` (read).
  - `save_recall(source_id, text)` (write). It saves the text as the user's verbatim words and returns the note id.
  - `get_recall_review(source_id)` (read). It includes `misses_are_card_candidates: true` in its output as a reminder.
- **`create_note` gains `authored_by: 'user' | 'claude'`, default `'claude'`.**
  - The tool description says to use `user` only when saving the user's own words verbatim (typo fixes allowed).
  - The UI shows a "by Claude" badge on notes and sources Claude authored, as it already does for cards and links.
- **Rewrite `process_reading`:**
  1. Identify or create the source.
  2. If the source has no recall, ask for a blank-page recall *before* showing, quoting or summarising any highlights. If I already pasted highlights, set them aside without discussing them, and import them silently with `import_highlights`.
  3. Save the recall with `save_recall`.
  4. Call `get_recall_review`. Report what I **missed** and what I **got wrong**, each tied to a highlight, then let me look at the highlights.
  5. Ask me to draft the 3–7 concept and claim notes myself, in the chat or in the UI.
  6. Critique each draft: accuracy against the highlights, atomicity (one idea?), a missing "why", and missing links. Ask what I think it connects to before showing `find_connections` candidates.
  7. Save my drafts with `authored_by: 'user'`.
  8. Propose cards: misses first, then my notes, each needing approval.
  9. Clearly secondary fallback: "say *suggest for me* and I'll draft notes for you". Those are saved with `authored_by: 'claude'` and marked as such.
- **`SERVER_INSTRUCTIONS` ground rules gain "the learner generates first":**
  - Ask for the user's attempt (recall, draft, connection or explanation) before offering your own.
  - Propose content only for gaps the attempt revealed, or when asked.

**UI**

- **Source page, when there's no recall and the status is reading or done:**
  - The top section becomes **"Recall first"**: a blank textarea with a timer readout and the line "Don't look anything up. What do you remember? Fragments are fine."
  - Highlights collapse to a count: "38 highlights hidden until you recall · `s` skip".
  - After saving, highlights appear next to the recall, and a **"Draft your notes"** step offers `n` to create a concept note (`N` for a claim) prefilled with the source.
- **Today:** the follow-up box opens the recall textarea instead of `CaptureHighlight`.
- **Import report:** "Next: recall first. Open each source and write what you remember before reading the highlights." The highlights themselves are imported normally; only the display is gated.
- **Shortcuts:** `r` focuses the recall box on the source page, `⌘↵` saves it, `s` skips it, and `n`/`N` add a concept or claim. All of these are listed under `?`.
- **First-use note** in the recall box: "The first 2–3 weeks will feel harder than rereading. That feeling is the effort that makes it stick." Used again in H.

### Phase B: interleaved review (principle 4) — done

- **`review.due()` separates *selection* from *ordering*.**
  - Selection is unchanged in priority (learning, then the most overdue reviews, then new cards within quota), so `limit` still drops the right cards.
  - Ordering becomes `interleave(cards, seed)`:
    - a seeded shuffle where `seed = hash(localDate + userSeed)`, so the order is reproducible within a day and in tests;
    - then a greedy pass that avoids putting two cards from the same note next to each other, and spreads cards from the same source and the same primary tag;
    - learning-step cards keep their earliest position (they're time-sensitive) but don't cluster.
  - A new setting, `interleave: true` by default, with `false` restoring the old order. `get_due_cards` and the UI use the new order.
- **Sibling burying:** at most one cloze sibling per note per day for **new** cards. Siblings that are due reviews are spread apart, not buried, so FSRS state is never touched.
- **New prerequisite-aware intake (pulled forward from D because it's an ordering change):** among new cards, a card whose note has an unlearned prerequisite (a `prerequisite_of` link from a note whose cards are all still new) is deferred behind that prerequisite's cards.
- **New `services/practice.ts`:**
  - `practiceSet({topics[], size, seed, includeNotDue})`: a mix across 2 or more tags or topics. It contains due cards first, then the lowest-retrievability cards that aren't due, interleaved so no two adjacent cards share a topic.
  - `confusables(topics[])`: concept and claim pairs that are easy to confuse. These come from `contradicts` and `related` links across the topics, plus high-similarity pairs from *different* tags. Each pair comes with both notes' text.
- **New MCP tools:** `get_practice_set` (read) and `get_confusable_pairs` (read).
- **New prompt `interleaved_practice(topics)`:**
  - Mix recall cards with **discrimination questions** written by Claude from the confusable pairs: a short scenario or claim, then "which concept or principle applies, and why?" plus a "why not the other one?" follow-up.
  - Card answers are recorded with `record_review`.
  - A missed discrimination question becomes a proposed card (open, prompt kind `discriminate`, refs to both notes).
- **UI:** the Review page gains a "Mix" multi-select of tags (`m`) that feeds `practiceSet`.
- **`review_logs.context`** records `daily` | `practice` | `exam` | `explain` | `ui`, so later analysis can separate in-schedule from early reviews. FSRS-6 handles early reviews natively, so these are recorded normally.

### Phase C: elaboration and self-explanation (principles 3, 6)

- **Why/how cards** use a column rather than a new card type: `cards.prompt_kind` (`recall` default | `why` | `how` | `connect` | `discriminate`).
  - Why a column: a new `type` value needs a CHECK change, which means rebuilding `cards`, the table that `review_logs` and `card_refs` hang from. A column is an `ALTER TABLE ADD COLUMN`: zero risk to FSRS state.
  - How it's used: `type` stays `open` or `synthesis`, and the prompt kind changes the grading. The UI and `create_card` present it as "Why/How" so the storage detail doesn't leak into use.
  - The UI shows a prompt-kind badge before reveal ("Explain *why*…"), so you know a mechanism is expected.
- **Rubric extension** (added to `RATING_RUBRIC`):
  - **why/how:**
    - *good* needs the causal mechanism, not just a restated definition;
    - naming the concept without the mechanism is *hard*;
    - a wrong mechanism is *again*.
  - **connect:**
    - *good* needs a specific relationship to a named idea, with direction;
    - "they're related" is *hard*.
  - **explain-it:**
    - *good* means a beginner could follow it and Claude's naive follow-ups found no gap in the core;
    - each gap in the core caps the rating at *hard*;
    - a misconception is *again*.
  - The lower rating still applies when borderline.
- **New prompt `explain_it(concept)`:**
  1. Claude finds the note (`get_note`) but **does not show it**.
  2. I explain it as if to a beginner.
  3. Claude plays a curious beginner: 3–5 naive follow-ups ("why does that happen?", "what's an example?", "how is that different from X?").
  4. Claude then lists the gaps, each with a one-line correction from my notes.
  5. Each gap becomes a proposed card (`why`/`how`) or a note edit.
  6. My explanation is optionally saved as an `explanation` note (`authored_by: 'user'`, linked to the concept).
  7. If the concept has cards, the matching one is recorded with the explain-it rubric (`context = 'explain'`).

  The prompt is added to `PROMPTS`, so `loom guide` and `docs/claude-project-guide.md` get it automatically.
- **Connect-on-create:**
  - **Core:** `notes.create` for `concept` or `claim` returns `connectPrompt` plus `candidates`, computed lazily through `related.similar(crossSource)`.
  - **MCP:** `create_note` returns these, and the ground rules say to *ask* "what does this connect to?" before showing the candidates.
  - **UI:** a new concept or claim note opens a **"Connect it"** panel:
    - "What does this build on, support, or remind you of?" with a `[[`-autocomplete field and a relation picker;
    - candidates stay hidden behind "show suggestions (`S`)" until you've added a link or pressed `S`.
  - `SimilarPanel` on all notes becomes collapsed-by-default, with the same "try first" line.
- **Revise the `connect` prompt** so I name candidate connections first, and Claude then adds `find_connections` results and critiques my links.

### Phase D: prerequisite awareness (principle 5)

- **New `services/foundations.ts`:**
  - `prerequisitesOf(noteIds, depth = 2)` follows `prerequisite_of` links (A → B means A is a prerequisite of B) upward.
  - **Weakness** of a prerequisite note:
    - none of its cards has stability ≥ 7 d; or
    - any card had a lapse in the last 30 days; or
    - mean retrievability < 0.8; or
    - **it has no cards at all** (an unrehearsed foundation).
  - `foundations()` ranks notes by dependant count (transitive) × weakness, for the Stats view.
- **`review.record`:** when the rating is *again* (or *hard* on a `why`/`how` card), the result includes `weakPrerequisites`: up to 3, each with its weakest card id.
  - `record_review` passes them through, and the `daily_review` script asks Claude to collect them for the end-of-session summary ("these failures share a weak foundation: X").
  - The UI session-done screen lists them, with `p` to start a mini-review of those prerequisite cards.
- **`study.context`** gains `foundations`: weak prerequisites of the topic's notes, including those outside the topic.
- **Stats** gains a **Foundations** table: concept, dependants, its cards' mastery and lapses (30 d), and a "review" link.
- Prerequisite links are sparse today. The `connect` and `explain_it` prompts will ask "does this depend on something you'd need to know first?" and propose `prerequisite_of` links you confirm.

### Phase E: spaced exam prep (principle 2)

- **New `exams` table:**
  - id, title, exam_date, scope (JSON: tags, source ids, free-text topics), session_minutes (default 25), target_retention (default 0.9), status, created_at.
  - `tasks.exam_id` added as a column.
- **New `services/exams.ts`:**
  - **`plan(exam)`:**
    - `D` = days left and `N` = cards in scope.
    - Session count = clamp(ceil(N × 1.5 / cardsPerSession), 3, D), where cardsPerSession ≈ session_minutes × 2.
    - Sessions are spread across the window with the final one on D−1. Gaps are about even early, with an extra review session in the last week. Cepeda et al. found the optimal gap to be roughly 10–20% of the retention interval; even spacing across a short window approximates this.
    - New cards in scope are front-loaded into the first half, so they get at least 2–3 spaced reviews before the exam.
    - Each session becomes a task on its day: kind `todo` with `exam_id`, titled "Exam prep 2/6: Organic chemistry (≈30 cards)".
  - **`sessionSet(exam, now)`** is computed when the session starts, not frozen at planning time. It contains:
    - due cards in scope;
    - cards whose predicted retrievability **on exam day** is below target, lowest first;
    - the remaining new cards in the front-load quota;
    - all of it interleaved across subtopics with the Phase B interleaver.

    The final session is a mixed mock exam weighted toward synthesis, why/how and discrimination questions.
  - **`replan(exam)`:** missed sessions don't pile up. Overdue session tasks are merged forward and the remaining sessions are re-spaced. It runs automatically when a session is more than a day overdue.
- **MCP:**
  - `create_exam_plan` (write) and `get_exam_session` (read). `complete_task` on a session task returns the next session date.
  - New prompt `exam_session(exam)` runs a planned session.
  - `exam_prep` stays for one-off sessions and now opens with "Is there an exam date? I can spread this out", offering `create_exam_plan`.
- **UI:**
  - On Today, exam session tasks open a practice-mode Review scoped to that session.
  - New **Exams** section on Today, with days left and planned/done/missed counts.
  - Create a plan with `E` on Today.

### Phase F: calibration (principle 7)

- **New `review_logs` columns:**
  - `confidence INTEGER` (1–4: guessing, unsure, fairly sure, certain), NULL when not asked;
  - `attempt TEXT`, the optional typed answer from the UI.
- **New setting `askConfidence`, on by default** (your choice: you want to experiment with it).
  - **UI, when on:** before reveal, `1`–`4` set confidence *and* reveal, and space reveals without one. After reveal, `1`–`4` rate as now. The key hints change with the phase so this is never ambiguous.
  - **MCP:** `record_review` gains `confidence`. When the setting is on, `daily_review` asks "how sure, 1–4?" together with the answer.
- **Fluency fixes in Review:**
  - `Enter` reveals only. A second `Enter` no longer rates Good; rating always needs a deliberate `1`–`4`.
  - `o` works only after reveal.
  - Open, synthesis and why/how cards get a **type-your-answer box** (`t` to focus) that's open by default, saved as `attempt`. Basic and cloze cards get it optionally.
  - The revealed answer is shown next to your attempt.
- **Calibration stats:**
  - For each confidence level, the actual success rate (rating ≥ good) and n.
  - For each topic, an overconfidence score: mean expected p (0.25/0.5/0.75/0.95) − actual rate. A topic is flagged when the score is > 0.15 with n ≥ 10.
  - `get_review_stats` and `get_study_context` include these flags, so Claude can say "you're consistently overconfident on #statistics".
- **Edge-of-ability hint (principle 9):**
  - If 30-day retention is > 0.95 with ≥ 50 reviews: "reviews may be too easy; consider lowering target retention or adding why/how cards".
  - If it's < 0.8: suggest fewer new cards a day or checking foundations.

### Phase G: production over consumption

- **`stats.production()`**, per source:
  - recall notes;
  - user-authored concept, claim and explanation notes;
  - user-created cards;
  - Claude-created items, shown separately and not counted as yours;
  - highlights;
  - status and finished date.

  The production ratio = your items / highlights (or per source, when there are no highlights).
- **"Finished but never processed":** sources that are `done` with no recall and no user-authored concept or claim notes.
- **Stats:** a Production table, sortable.
- **Today:**
  - A small nudge card: "3 finished sources never processed. *Oldest: Thinking, Fast and Slow (22 days)*", with `P` to open the recall flow for the oldest.
  - The reading-queue items show a production dot.

### Phase H: the personal experiment

- **New `sources.method` column** (`recall_first` | `highlights_first` | NULL):
  - set by Phase A;
  - backfilled to `highlights_first` for sources that already have notes at migration time;
  - editable on the source page.
- **`stats.experiment()`:**
  - **Delayed retention** = the share of review-phase answers given ≥ 7 days after the card was created that weren't rated Again, grouped by the card's source method.
  - Each group shows reviews, cards, sources, its rate and a Wilson 95% interval.
  - The verdict reads "not enough data" until each group has ≥ 30 such reviews from ≥ 3 sources.
  - Caveats are listed in the UI: newer sources sit in one group, books differ in difficulty, and the novelty effect.
  - Claude-authored cards are excluded by default, with a toggle to include them.
- **Stats panel "Is recall-first working for you?"**: two bars with their intervals, plus the 2–3-weeks-feels-harder note.

### Explicitly not doing

- Sleep and exercise tracking, gamification, a focus timer: out of scope, as you said.
- Auto-grading open answers in the UI: the app never calls an LLM. Typed attempts are stored, so Claude can look at them later if you ask.

---

## 3. Schema migrations

### Migration 003: one file, the riskiest part, done once

It runs under the Phase 0 runner: pre-migration backup, foreign keys off, transaction, `foreign_key_check`, foreign keys back on.

**`notes` table rebuild** (needed to change the `kind` CHECK):

```sql
CREATE TABLE notes_new (... same columns ...,
  kind TEXT NOT NULL DEFAULT 'note'
       CHECK (kind IN ('note','highlight','concept','claim','summary','recall','explanation')),
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')));
INSERT INTO notes_new SELECT id, kind, title, body, quote, location, source_id, aliases, dedupe_key,
  created_at, updated_at, 'user' FROM notes;
DROP TABLE notes;                 -- FKs are OFF, so cards.note_id CASCADE does NOT fire
ALTER TABLE notes_new RENAME TO notes;
-- recreate indexes notes_source, notes_title, notes_kind, notes_dedupe
-- recreate triggers notes_fts_i/u/d and notes_cleanup (dropped with the old table)
```

- The **FTS rows are untouched.** `notes_fts` is a separate table keyed by id, so search keeps working without a rebuild.
- `cards.note_id` and `tasks.note_id` still point at the same ids, and `foreign_key_check` proves it.
- **Authorship backfill:**
  - notes with `dedupe_key` LIKE `kindle:%` / `paste:%` → `system` (imported quotes). Markdown imports stay `user`, since they're your own files;
  - notes that are the `from` end of a `claude` link with rationale `extracted from` → `claude`;
  - everything else → `user`.

  The source page lets you correct the authorship of any note.

**Plain `ALTER TABLE … ADD COLUMN`s** (no rebuild):
- `sources.method TEXT CHECK (method IN ('recall_first','highlights_first'))` and `sources.created_by TEXT NOT NULL DEFAULT 'user'`.
- `cards.prompt_kind TEXT NOT NULL DEFAULT 'recall' CHECK (...)`.
- `review_logs.confidence INTEGER CHECK (confidence BETWEEN 1 AND 4)`, `review_logs.attempt TEXT`, and `review_logs.context TEXT`. Existing rows get NULL: unknown context, no confidence.
- `tasks.exam_id TEXT REFERENCES exams(id) ON DELETE SET NULL`.

**New table:** `CREATE TABLE exams (...)`.

**Backfill:** `UPDATE sources SET method = 'highlights_first' WHERE id IN (SELECT DISTINCT source_id FROM notes WHERE source_id IS NOT NULL)`.

I'd ship 003 at the start of Phase A, even though it carries columns that later phases use. That keeps it to one schema change, one backup and one test fixture. Later phases add only new tables if they need them.

### What is never touched

- `cards`: no rebuild. Only one column is added, so **every FSRS field (due, stability, difficulty, reps, lapses, state, last_review, learning_steps) is preserved bit-for-bit.**
- `review_logs`: no rebuild, no updates to existing rows, and `prev_card` snapshots are intact, so undo still works across the migration.
- `card_refs`, `links`, `item_tags`, `chunks` and all FTS tables are untouched.

### Verification

The migration test, plus a manual run against a copy of your real `~/.loom/loom.db`, checks:
- row counts before and after for every table;
- an equality check on `SELECT * FROM cards ORDER BY id` and `review_logs`, excluding only the new columns;
- `foreign_key_check` returns nothing;
- full-text and semantic search find the same notes;
- `undo` of the pre-migration review restores the card.

The backup file path is printed, so rollback is just copying it back.

---

## 4. Open choices (I'll go with the default unless you say otherwise)

1. **Why/how as `prompt_kind` on open cards rather than a new card `type`.** Default: `prompt_kind`, because it avoids rebuilding the cards table. The UI presents it as its own card type.
2. **Highlight gating is UI-only.** The API and MCP return highlights, and the MCP prompts tell Claude not to show them before recall. Default: UI-only, because hard-gating the API would break `get_recall_review`.
3. **Confidence prompt: ON** (decided). It adds a keypress per card; it can be turned off on Stats and on Review (`K`).
4. **Interleaving on by default**, with a setting to switch it off.
5. **Exam plan sizing** of ~2 cards per minute and a final mock exam. Adjustable per plan.
