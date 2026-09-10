# UGC Creator: Context Discovery Notes
Date: 2026-06-19 · Goal: Extract durable, in-head context (business, goals, working prefs) not already in the spec/plan/README, to seed the auto-loaded project-context.md

## Summary / key decisions
(running synthesis, updated as we go)

## Already documented (harvested — NOT re-asking)
- **What it is:** Self-hosted Next.js app. Product photo → classify (Claude vision) → scrape viral TikTok/Reels clips (Apify, ≥1M views, music-only) → face-swap via WAN 2.2 Animate (fal/Replicate) → light ffmpeg distinctiveness pass → approval queue → manual posting.
- **Architecture:** One Next.js app at localhost:3000; isolated tested modules in src/lib/; SQLite + local filesystem; every heavy step is an external HTTP API (no GPU/Python).
- **Tech:** Next.js, TypeScript strict, better-sqlite3, Vitest, fluent-ffmpeg, Apify, fal/Replicate, Anthropic SDK, (Banana Pro / KIE for avatars).
- **Per-product memory:** answers remembered by product type to skip re-onboarding.
- **Recent work (this session):** added approval gate (pick viral clip), face-photo upload, auto-advancing job pipeline, fal storage upload for swap URLs, readable UI theme.

## Q&A log

### Q1 — Commercial model / who runs it
- Asked: Is this an agency service, SaaS, or personal? Who are the clients?
- Captured: **Distributed self-hosted tool.** Kendrew pushes the app to a **private GitHub repo**, gives clients access, they **clone it and run it on their own physical laptops**. Kendrew **personally sets it up for each client** (env keys, install, first run). NOT a central SaaS Kendrew hosts; NOT Kendrew running an agency that delivers finished videos. Each client operates their own local copy.
- Implications: distribution = git clone + manual setup per client; setup ergonomics (README, .env, ffmpeg install, first-run UX) matter a lot since non-technical clients run it themselves; no central server, no multi-tenant auth needed; each laptop holds its own SQLite + media + API keys.
- Flags: who pays for the API usage (each client's own keys vs Kendrew's)? -> Kendrew (Q-pending)

### Q2 — API keys ownership
- Asked: Whose keys, and how do clients get them?
- Captured: **Each client uses their OWN API keys.** Kendrew helps them sign up / obtain keys during setup, but the keys belong to the client. Cost/usage is isolated per client; no shared Kendrew keys distributed.
- Implications: repo must ship `.env.example` only (NEVER real keys); onboarding must include a clear "how to get each key" walkthrough (Anthropic, Apify, fal, KIE); a friendly setup/first-run experience matters since clients are doing their own key wiring. Kendrew's local `.env` (with his own real keys for dev/testing) must stay gitignored and never be committed to the private repo.
- Flags resolved: key ownership = client's own.

### Q3 — How Kendrew wants me to work
- Asked: commits, autonomy, TDD/process preferences.
- Captured:
  1. **Commits: only when Kendrew explicitly says so.** Never auto-commit/push. (Branch currently has uncommitted session work — leave it until told.)
  2. **Autonomy: run tasks to completion, BUT check in whenever an important decision needs making.** Use judgment; surface real decision points, don't stop for trivia.
  3. **Process: follow the superpowers discipline by default** (brainstorm → plan → build one tested block at a time → review). TDD/block-by-block is the default going forward, not opt-in.
- Action item from this answer: import the valuable parts of Matt Pocock's `improve-codebase-architecture` skill into the local skill toolbox. If the whole folder can't be imported cleanly, grab only the important files and adapt them (self-contained, reusing existing /grill-me instead of his /grilling).

### Action — Import Matt Pocock architecture skill (DONE)
- Decided NOT to edit the superpowers plugin cache (gets wiped on update). Installed a self-contained, adapted skill at `~/.claude/skills/improve-codebase-architecture/SKILL.md`.
- Folded in his `codebase-design` vocabulary (module, interface, depth, seam, adapter, leverage, locality, deletion test, testability heuristics). Kept the 3-phase Explore→Report→Grill process. Rewired deps to tools Kendrew has: uses `grill-me` (not his `/grilling`), hands execution to superpowers writing-plans → subagent-driven-development. ADR/glossary steps kept as optional.

### Q4 — Target market / positioning
- Asked: who's the buyer, what niche, what's the edge?
- Captured:
  - **Market: Indonesia** — there is essentially **no established UGC-creator program/ecosystem** there, so the tool fills a gap rather than competing with Fiverr/Arcads-style services.
  - **Positioning/pitch:** "You don't have to make your own videos — this tool makes them for you. It copies viral videos so your own videos follow a similar (proven) template."
  - **Product niche:** more niche **fashion & beauty** — physical products that are about *looks/appearance*.
  - **Customers: brands** (not individual creators).
- Implications: viral-clip scraping + template-copying is the core value prop; fashion/beauty appearance products are the sweet spot (face-swap onto a look-focused product makes sense); localization (Indonesian language UI/onboarding?) may matter later.
- Flags: Indonesian-language UI/content needed? -> Kendrew (later)

### Q5 — Pricing / business model
- Asked: one-time vs subscription, price point, lock-in.
- Captured: **Subscription model.** Kendrew charges a subscription to set everything up; and to **keep receiving updates (stay connected to the GitHub repo)**, a continuing subscription is required. The update stream + repo access is the lock-in (a client could keep a frozen copy after one payment, but loses updates).
- Implications: repo access management (add/remove client access on subscription status) matters; an update/changelog cadence justifies the recurring fee; consider how clients pull updates (git pull instructions / a simple update flow).
- Flags: exact price point / IDR not specified yet.

### Action — Consolidate website skills into one master (DONE)
- Created `~/.claude/skills/master-web/SKILL.md` as the single master orchestrator. Absorbed all of `website-tips` (phase map, deployment stacks, ownership, GitHub→Hostinger→Cloudflare setup, pricing, contract) and ADDED the missing phases: `/security-review` (code/white-box), `security` (live/black-box), `privacy-ui`, `legal`, and `site-audit` (full pre-launch sweep).
- Removed the now-redundant `website-tips` skill (content fully preserved in master-web) so there is exactly ONE master.

## Open flags (pending input)
- (Offered) Verify git history is clean of any committed secrets before pushing to private GitHub -> awaiting Kendrew yes/no
- Indonesian-language UI / onboarding needed for clients? -> Kendrew (later)
- Exact subscription price point (IDR) -> Kendrew (later)
- How clients pull updates (git pull walkthrough vs in-app update) -> Kendrew (later)
