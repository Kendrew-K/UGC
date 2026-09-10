# Project Context — UGC Creator

> Auto-loaded at the start of every Claude Code session via a SessionStart hook
> (`.claude/settings.local.json`). Keep it current — this is the shared source of
> truth so Claude starts each session already on the same page.
> Raw discovery notes: `brainstorms/2026-06-19-ugc-creator-context.md`.

## What it is

A self-hosted Next.js app that turns a client's product photo into ready-to-post
UGC videos. Pipeline: **classify product (Claude vision) → scrape viral TikTok/Reels
clips (Apify, ≥1M views, music-only) → client picks a clip (approval gate) →
face-swap via WAN 2.2 Animate (fal/Replicate) → light ffmpeg distinctiveness pass →
approval queue → manual posting.** Every heavy step is an external HTTP API — no GPU
or Python needed.

## Commercial model (important)

- **Distributed self-hosted tool**, NOT a SaaS Kendrew hosts and NOT an agency that
  delivers finished videos.
- Kendrew pushes the app to a **private GitHub repo**; each client **clones it and
  runs it on their own laptop**. Kendrew **personally sets it up** for each client.
- **Each client uses their OWN API keys** (Anthropic, Apify, fal, KIE). Kendrew helps
  them sign up/obtain keys during setup; cost/usage is isolated per client.
- Consequences: setup ergonomics matter a lot (non-technical clients run it
  themselves) — clear README, `.env.example`-only, a key-by-key signup walkthrough,
  ffmpeg install help, friendly first-run UX. The repo must NEVER contain real keys;
  Kendrew's local `.env` (his own dev keys) stays gitignored.

## Architecture

One Next.js (TypeScript, strict) app at `localhost:3000`. Backend logic in isolated,
individually-tested modules under `src/lib/`, orchestrated by a job state machine.
SQLite (`media/app.sqlite`) for records; local filesystem (`media/`) for media. All
external API calls live in `src/lib/` modules — UI/API routes never call third-party
APIs directly. The swap provider is abstracted behind one interface (fal vs Replicate
chosen by benchmarking, never hardcoded at a call site).

Job statuses: `queued → awaiting_approval → downloading → swapping → processing →
ready → failed` (approval gate added this session; clients pick which viral clip).

Full detail: `docs/superpowers/specs/` and `docs/superpowers/plans/2026-06-19-ugc-creator.md`.

## How Kendrew wants Claude to work

1. **Commit ONLY when Kendrew explicitly says so.** Never auto-commit or push.
2. **Run tasks to completion, but check in whenever an important decision is needed.**
3. **Follow the superpowers discipline by default** — brainstorm → plan → build one
   tested block at a time → review (TDD/block-by-block is the default, not opt-in).
- Prefer plain-language tradeoff explanations with one clear recommendation over
  option menus. Kendrew values things that actually work end-to-end for non-technical
  users, not just green tests.

## Current state (as of 2026-06-19)

- Branch `build/ugc-creator` has **uncommitted** work from recent sessions (leave
  until told to commit): media-type detection fix, auto-advancing pipeline + approval
  gate, face-photo upload, fal storage upload for swap URLs, readable light UI theme,
  `chosen_candidate_json` column + migration. 26 unit tests passing.
- Session-start now auto-loads this file + `/superpowers`.
- Installed a personal `improve-codebase-architecture` skill (~/.claude/skills/).

## Open items

- Verify git history is clean of committed secrets before pushing to private GitHub
  (offered, not yet done).
- The fal storage `uploadForUrl` path is implemented but not yet verified against the
  live fal API.
