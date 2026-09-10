# UGC Creator: Gap-Filling Grill Session
Date: 2026-06-21 · Goal: Surface everything NOT yet captured — product decisions, open flags, and anything still in Kendrew's head

## Summary / key decisions
(running synthesis, updated as we go)

## Already known (not re-asking)
- Self-hosted, distributed to clients via private GitHub repo
- Each client uses own API keys (Anthropic, Apify, fal, KIE)
- Commit only when told; check in on big decisions; follow superpowers discipline
- Market: Indonesia, fashion & beauty brands, subscription model for access + updates
- Pipeline: classify → scrape viral clips → approval gate → face-swap → ffmpeg → ready queue

## Open flags from previous session
- Git history clean of secrets? (offered, not yet done)
- Indonesian-language UI? (deferred)
- Exact subscription price (IDR)? (deferred)
- How clients pull updates? (deferred)

## Q&A log

### Q1 — Source of the face / avatar
- Asked: Who supplies the face being swapped in?
- Captured: **The client supplies their own face.** Two options: (1) upload a real photo of themselves, or (2) generate an AI avatar using WAN 2.2. Both paths go through the same face-swap pipeline. The client is not using Kendrew's avatars — each client has their own identity in the output video.
- Implications: The app needs a clear "create avatar" flow (WAN generation path) as an alternative to photo upload. KIE/fal must support both a real photo and a WAN-generated image as the swap source.
- Flags: Is the WAN avatar generation step already built, or is it a planned feature? -> see Q next

### Q2 — WAN avatar generation: built or planned?
- Captured: Was planned (face.ts had the generation logic) but not wired into the pipeline or UI.
- Resolution: Fully built. `generating_face` status added to state machine; pipeline `generateFace` step calls `resolveFace({kind:'generate', prompt})`; API accepts `facePrompt`; UI shows prompt textarea in generate mode.

## What was built (2026-06-21)
- `face_prompt TEXT` column added to jobs table (schema + idempotent migration)
- `generating_face` added to JobStatus and AUTO_ADVANCE_STATUSES
- `createJob` accepts `{ status, facePrompt }` opts
- `advanceJob` handles `generating_face → queued` transition
- `PipelineSteps.generateFace` added; `buildSteps` wires it to `resolveFace`
- POST /api/jobs accepts either `faceImageBase64` or `facePrompt`
- ProductUpload shows Upload/Generate toggle with prompt textarea
- 30 unit tests passing (3 live integration skipped)

## Open flags (pending input)
- Indonesian-language UI / onboarding? -> Kendrew (later)
- Exact subscription price (IDR) -> Kendrew (later)
- How clients pull updates? -> Kendrew (later)
- Verify git history clean of secrets before pushing to private GitHub -> Kendrew
