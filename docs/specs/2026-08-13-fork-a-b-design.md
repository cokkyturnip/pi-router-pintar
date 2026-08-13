# Design: pi-smart-router fork — A (loop-escalation reliability) + B (model classification)

**Fork:** `beettlle/pi-smart-router` v0.16.0 → `cokkyturnip/pi-smart-router`
**Workspace:** `~/Documents/Github Repo/pi-smart-router`
**Branches (split per 1-issue-per-branch):**
- **A** → `fix/loop-escalation-status-signal`
- **B** → `fix/mapper-gpt-5x-frontier`

This design doc is committed to the fork `main` as the maintenance record. It is
deliberately **not** part of the upstream-bound fix branches (upstream PRs stay
code + tests only).

## Goal
Two scoped changes to the long-lived fork:
- **A — Reliability:** make loop-escalation failure detection reliable (no body-substring
  false positives / false negatives).
- **B — Classification:** fix model classification so latest models (e.g.
  `openai/gpt-5.6-luna`) land in the correct tier (`frontier-cloud`), not silently dropped
  to `economical-cloud`.

**Scope guard (Lae):** B does **NOT** add new routing logic or an N-way engine. The N-way
(3-tier) + task-aware + cost-aware routing pipeline already exists in the upstream. B only
fixes classification patterns / adds latest-model rules.

## Root cause (verified from source + state.db)

### A — loop-escalation false positives/negatives
`src/domain/pinning/loop-escalation.ts`:
- `looksLikeFailure(content)` greps the tool-result **body text** for `FAILURE_PATTERNS`
  (`error`, `fail`, `exception`, `timed out`, `timeout`, `econnrefused`, `enotfound`,
  `econnreset`, `epipe`).
- **False positive:** benign tool output containing the word "error" (e.g. "no error",
  "error handling") is counted as a failure.
- **False negative:** a real failure whose text lacks the keyword (e.g. "Rate limit
  exceeded", HTTP 429) is missed.
- Verified in `state.db`: session `019ff698` had `consecutive_tool_failures` 2→9→13 on
  benign `tool_result` turns (signatures `tf:c3f753d0`, `tf:703d4611`, `tf:9e434ae6`),
  all `isError:false` in host telemetry — yet counted as failures. Escalation never fired
  because the fleet had **0 frontier models**.

**Signal constraint (verified):** `RoutingRequest` / `Message` (`src/domain/types/entities.ts`)
carry **no** `statusCode` / `is_error`. `loop-escalation` only sees tool-result message text.
So a status/flag check must be **added** to the message schema (host-populated), not read
from a non-existent field. The correct semantic signal the host already knows (it emits
`isError` in telemetry) should be plumbed into the message.

### B — stale gpt frontier pattern
`src/config/pi-model-mapper.ts`:
- Line 329: gpt frontier pattern is `/gpt[-_.]?5\.5|gpt-5-5/i` — only matches `5.5`.
- `openai/gpt-5.6-luna` (and 5.7+) falls through to `UNKNOWN_DEFAULTS` (`economical-cloud`,
  lines 258–259).
- Result: a latest flagship is mis-tiered as economical → the `frontier-cloud` tier is
  under-populated → `triage`/`turn_envelope`/escalation cannot select a frontier model.

## Design

### A — Reliable failure detection
1. Extend `Message` (`src/domain/types/entities.ts`) **and** `MessageSchema`
   (`src/domain/types/schemas.ts:61`) with optional, backward-compatible fields:
   - `readonly is_error?: boolean;`
   - `readonly status?: number;`  (HTTP-ish status of the tool/provider result)
   The host (pi) already knows success/failure at the tool-result level (it emits `isError`
   in telemetry) and should populate these. Absence → fallback to body heuristic.
2. In `src/domain/pinning/loop-escalation.ts`:
   - Refactor `latestToolContent(request)` → `lastToolMessage(request)` returning the
     `role:'tool'` message object.
   - New `isToolFailure(msg)`:
     ```ts
     if (msg.is_error === true) return true;
     if (msg.status !== undefined && msg.status >= 400) return true;
     return looksLikeFailure(msg.content ?? '');
     ```
     Structured flag/status wins; body grep only as fallback.
   - Tighten `looksLikeFailure` to cut benign false positives: require the failure keyword
     as a standalone token / strong phrase (avoid "no error", "without error"); keep catching
     real failures (`error`, `fail`, `exception`, `timeout`, `refused`, `rate limit`, `429`,
     `quota`, `denied`). Add `RATE_LIMIT_PATTERNS` for the previously-missed 429/rate-limit
     class.
   - `extractToolFailureSignature` uses `isToolFailure`; `computeSignature` still hashes
     content for identical-failure grouping (unchanged).
   - `isUnsupportedOrUnknownToolResult` unchanged (capability signal; body-based is fine).
3. Behavior: real failures (host flag OR 4xx/5xx OR strong body phrase) are counted; benign
   "error" text is not → no false-positive escalation; escalation fires when threshold is
   reached **and** a `frontier-cloud` model exists in the fleet.

### B — Model classification (audit existing mapper coverage)
**Scope (per Lae):** do NOT pull from an external catalog or a personal fleet. Audit the
model families `pi-model-mapper.ts` ALREADY patterns for, and map each to the correct
EXISTING smart-router tier (`zero-tier` / `economical-cloud` / `frontier-cloud`). Fix only
the stale / mis-tiered rule.

Existing `MODEL_PATTERN_RULES` (first match wins) + special cases, mapped to existing tiers:

| # | Family smart-router already handles | Current tier | Correct existing tier | Verdict |
|---|---|---|---|---|
| 1 | claude opus / sonnet | frontier-cloud | frontier-cloud | ✓ |
| 2 | claude haiku | economical-cloud | economical-cloud | ✓ |
| 3 | gpt-5.5 / gpt-5-5 | frontier-cloud | frontier-cloud | ✗ STALE: 5.6+ not covered |
| 4 | gpt-5.1 / gpt-5-mini | economical-cloud | economical-cloud | ✓ |
| 5 | gemini 2.5 pro | frontier-cloud | frontier-cloud | ✓ |
| 6 | gemini 3.x pro | frontier-cloud | frontier-cloud | ✓ |
| 7 | gemini *pro (any) | frontier-cloud | frontier-cloud | ✓ |
| 8 | gemini *flash | economical-cloud | economical-cloud | ✓ |
| 9 | composer-* (Cursor) | frontier-cloud | frontier-cloud | ✓ |
| 10 | cursor/* (auto) | frontier-cloud | frontier-cloud | ✓ |
| S1 | local (lmstudio/ollama) | zero-tier | zero-tier | ✓ |
| S2 | `default` (opaque fleet) | frontier-cloud | frontier-cloud | ✓ |
| S3 | unmatched → UNKNOWN_DEFAULTS | economical-cloud | economical-cloud (conservative) | ✓ |

Only rule #3 is wrong: the gpt frontier pattern only matches `5.5`, so `gpt-5.6`, `5.7`,
`5.8`, `5.9`, `5.10+` fall through to `UNKNOWN_DEFAULTS` (economical). That mis-tiers the
latest GPT flagships as economical.

**Fix (single change in `src/config/pi-model-mapper.ts`):** generalize rule #3
- from `/gpt[-_.]?5\.5|gpt-5-5/i`
- to   `/gpt[-_.]?5\.(?:[5-9]|\d{2,})|gpt-5-[5-9]/i`

→ `gpt-5.5`/`5.6`/.../`5.9`/`5.10+` and `gpt-5-5`..`gpt-5-9` → `FRONTIER_DEFAULTS`
(frontier-cloud). `gpt-5.6-luna` is covered by the `gpt-5.6` substring.

Rule order stays safe: `gpt-5.1` / `gpt-5-mini` still match rule #4 (economical); the new
pattern does not match `5.1` / `mini`, so first-match-wins is unaffected.

No new provider families, no new tiers, no external data sources.

### How A + B compose (for Lae)
- **B** classifies `openai/gpt-5.6-luna` as `frontier-cloud` → frontier tier populated.
- **A** detects real tool failures correctly (no false positives from benign text).
- With a frontier model present, `selectEscalationTarget` returns it; `evaluateLoopEscalation`
  escalates economical/zero pins after N real failures → escalation finally fires.
  (Previously blocked by 0 frontier models + false-positive body match.)

## Components / files touched
| File | Change | Branch |
|---|---|---|
| `src/domain/types/entities.ts` | `Message`: +`is_error?`, +`status?` | A |
| `src/domain/types/schemas.ts` | `MessageSchema`: +`is_error?`, +`status?` | A |
| `src/domain/pinning/loop-escalation.ts` | `lastToolMessage`, `isToolFailure`, tightened `looksLikeFailure` | A |
| `src/config/pi-model-mapper.ts` | gpt frontier regex generalization | B |
| `tests/unit/loop-escalation.test.ts` | unit tests for `isToolFailure` (flag/status/body) | A |
| `tests/unit/pi-model-mapper.test.ts` | unit tests (gpt-5.6/5.6-luna/5.7 → frontier) | B |
| `docs/specs/2026-08-13-fork-a-b-design.md` | this design (on `main` only) | — |

## Data flow
host tool_result message (`role:'tool'`, optional `is_error`/`status`) → router-pipeline
`loop_escalation` stage → `evaluateLoopEscalation` → `extractToolFailureSignature`(`isToolFailure`)
→ count consecutive real failures → `tryEscalate` → `selectEscalationTarget` (frontier in fleet).

## Error handling
- Missing `is_error`/`status` → fallback to tightened body heuristic (backward-compatible).
- No frontier in fleet → returns `no_frontier_available` (unchanged); caller safe-defaults.
- Schema fields optional → existing hosts/tests unaffected.

## Testing
- Unit `isToolFailure`: true on `is_error:true`; `status>=400`; strong body phrase. False on
  benign "no error", `status:200`, empty content.
- Unit mapper (audit existing coverage): `gpt-5.5`→frontier, `gpt-5.6`→frontier,
  `gpt-5.6-luna`→frontier, `gpt-5.1`→economical, `gpt-5-mini`→economical,
  `gpt-5.2`→economical (UNKNOWN), `claude-opus`→frontier, `claude-haiku`→economical,
  `gemini-2.5-pro`→frontier, `gemini-flash`→economical.
- Run `npm run verify:ci` (build + typecheck + lint + coverage) before any PR.
- Keep change on `fix/...` branch; PR to upstream (`beettlle`) and merge to fork `main` via
  the `sync` buffer branch (per fork workflow).

## Out of scope
- New routing stages / N-way engine (already exists upstream).
- Changing escalation-threshold semantics.
- Host (pi) changes to populate `is_error`/`status` (recommended follow-up; fallback covers
  current behavior).
- `package-lock.json` churn from `npm install` is excluded from fix branches.
