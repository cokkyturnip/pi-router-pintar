# Design: Plan B — per-request complexity re-scoring + selective bidirectional switching

**Fork:** `cokkyturnip/pi-smart-router` (was `beettlle/pi-smart-router`)
**Workspace:** `~/Documents/Github Repo/pi-smart-router`
**Package:** `pi-router-pintar` (published, currently `0.16.2`)
**Proposed branch:** `feat/plan-b-complexity-rescore`
**Status:** Draft (pending user review)

This design doc is the maintenance record for Plan B. It is deliberately **not**
part of the upstream-bound change set until the user approves implementation.

---

## Goal

Make the smart-router adapt the selected model to **per-request task complexity**
instead of only switching on hard events (context overflow, history compaction,
model-unhealthy). The router should be able to:

- **Upgrade** to a frontier model for one or a few genuinely heavy turns.
- **Downgrade** back to an economical model after a sustained run of light turns.

…while **never flip-flopping** (no model thrash within a session).

This is a behavior change only. It does not alter pricing math elsewhere, except
where noted (cost estimation fix).

---

## Context / Problem

### Observed behavior (real session `019ff9f6…`, 2026-08-13)

The router "locks" one model per session via `SessionPinner`:

```
09:22  hy3-free     pinned (light context)
09:28  OVERFLOW     → gpt-5.6-luna (hy3-free 190k window exhausted)
09:33  gpt-5.6-luna pinned (sticky)
09:38  COMPACTION   → break pin
09:39  hy3-free     pinned again (context now small)
…      hy3-free     until session end
```

The model only changes on **hard events** (`compaction_flag`, context-overflow
headroom failure, unhealthy model). Between those events it is sticky even when
the task clearly changes weight.

### Why `turn_type` alone is too coarse

`classifyTurnEnvelope` (`src/domain/triage/turn-envelope.ts`) labels each request
from keyword regexes:
- `tool_result` — last message is a tool result ≤ 50k tokens.
- `planning` — "plan|architect|design|refactor|migration|…" in last 3 messages.
- `subagent` — "subagent|explore|delegate|…".
- `main_loop` — default.

Problems:
- *"buAT RINGKASAN dari link youtube"* → `main_loop` (labeled light, but fetching +
  summarizing a long transcript is real work).
- *"plan besok mau apa"* → `planning` (labeled heavy, but trivial).
The label is keyword-based, not weight-based.

### Cost estimation is wrong (average, not weighted)

`deriveFallbackCostPer1M` (`src/config/pi-model-mapper.ts`) computes:

```ts
(input_rate + output_rate) / 2   // arithmetic mean
```

Real rates (per token): `gpt-5.6-luna` in 0.10 / out 0.60; `hy3` in 0.12 / out 0.53.
Because **input tokens dominate output tokens** (often 20–50×), the break-even is
`I = 3.5 × O`. Past that, `gpt-5.6-luna` is *cheaper in real cost* than `hy3`,
yet the mean makes `hy3` look cheaper (0.325 vs 0.35). Frugality therefore can pick
the wrong (and weaker) model.

The mapper must therefore retain separate normalized input/output rates and carry
Pi's `contextWindow`/`maxTokens` into `ModelProfile.limits`; today the pinner cannot
see the real per-model window.

### Capability is under-weighted on switch

`evaluateModelSwitchBreakeven` / `evaluateCacheEconomics` are **pure cost**. A
`hy3`-paid vs `gpt-5.6-luna` pair differs only ~$0.02/1M but capability differs
sharply (reasoning 0.7 vs 0.95; context 190k vs 1M). The switch logic can refuse to
upgrade "because $0.02 isn't worth it" — ignoring a large capability gap.

Tier *selection* (`expected-cost.ts`) does weight capability (`pSuccess`,
`costQualityAlpha`), but the *switch/breakeven* path does not.

---

## Goals / Non-goals

**Goals**
1. Re-score complexity on every request and let a pinned session switch when justified.
2. Upgrade only on high-confidence heavy turns (subject to context-fit + breakeven + flip-flop guard).
3. Downgrade only after N consecutive light turns + cooldown + cache-safety.
4. Stay sticky (hysteresis) when score is ambiguous or confidence is low.
5. Fix cost estimation to use real weighted cost, and add a capability-weight term.
6. Preserve all existing hard break rules (compaction, overflow, cache, SAAR idle).

**Non-goals**
- Changing the pricing registry or `models-store.json`.
- Changing `computeOutputHeadroom` / delegation overflow handling.
- Auto-classifying model tiers (separate concern, already handled).
- Replacing SAAR or sub-routing (they remain higher-priority special cases).

---

## Design (Approach 1)

Keep the logic inside `SessionPinner` (where pin state, break rules, the
`FlipFlopGuard`, and SAAR already live). Add:

1. A **pure scoring module** `src/domain/routing/complexity-scorer.ts`.
2. A **switch-rule evaluator** `evaluateComplexitySwitch()` inside `SessionPinner`,
   called after `evaluateBreakRules` and before the default `use_pin`.

No new pipeline stage, no new top-level module beyond the scorer.

### `lookupPin` order (unchanged structure, one insertion)

```
1. force_model_id override
2. if no pin → no_pin
3. evaluateBreakRules()        // compaction / overflow / cache  (HARD, unchanged)
4. pinOnlyFallback             // emergency behavior, unchanged
5. SAAR policy                  // buffer/hard-lock cases keep priority
6. evaluateComplexitySwitch()  // ← NEW: scorer-driven persistent upgrade/downgrade
7. sub_routing (tool_result)   // unchanged
8. default use_pin             // unchanged
```

Hard break rules always win. Complexity switching only acts when the pin is
healthy and no higher-priority policy fired. It never persistently switches on a
`tool_result`; sub-routing continues to handle those temporary economical calls.

---

## Complexity Scorer

**Input:** `RoutingRequest` — `estimated_input_tokens`, `turn_type`, `messages`,
plus the pinned and candidate `ModelProfile`s (capabilities, context window, and
separate normalized input/output rates).

**Output-cost estimate:** until real output-token prediction exists, estimate
`output_tokens = ceil(input_tokens × output_to_input_ratio)`. The default ratio is
`0.05` (a conservative upper bound; real sessions may be below 1%) and is configurable
only in the inclusive range `[0, 0.05]`. There is no artificial output floor in this
*cost* calculation; delegation headroom keeps its separate 256-token safety floor.

**Signals (the "D" set, all used):**
1. `estimated_input_tokens` — context pressure vs pinned model window.
2. `turn_type` — `planning` raises, `tool_result`/`subagent` lowers, `main_loop` neutral.
3. Heuristic prompt scan — lightweight regex (<2ms) for code blocks, `architect`/
   `refactor`/error markers, reasoning requests.
4. **Capability gap** — difference in `reasoning` capability and context window
   between pinned and candidate tiers.
5. **Real weighted cost** — `(input_tokens / 1M) × input_rate_per_1m +
   (estimated_output_tokens / 1M) × output_rate_per_1m`, not the arithmetic mean.

**Output:**
```ts
interface ComplexityScore {
  score: number;          // 0..1  (1 = heavy/frontier-worthy)
  targetTier: Tier | null;// suggested tier, or null = follow pin
  confidence: number;     // 0..1
  reasons: string[];      // explainability (SMART_ROUTER_LOG_ROUTING)
}
```

**Proposed initial thresholds (tunable via config/env):**
- `score >= 0.70` AND `confidence >= 0.60` → suggest frontier (upgrade).
- `score <= 0.30` AND `confidence >= 0.60` → suggest economical (downgrade candidate).
- otherwise → `targetTier = null` (stay on current pin; hysteresis).

These are starting points; they must be validated against telemetry, not treated
as final.

---

## Switch Rules (`evaluateComplexitySwitch`)

### Upgrade (pinned economical → frontier)
Requires ALL:
- scorer `targetTier === 'frontier-cloud'` with high confidence.
- `context_fit` OK for the candidate (no overflow).
- `evaluateModelSwitchBreakeven(pinned, candidate, …).shouldSwitch` OR capability
  gap large enough that the $0.02-style delta is irrelevant (capability-weight term).
- `FlipFlopGuard` does not block the tier change.

Returns `{ action: 'use_pin', pinnedModel: candidate }` (or a `saar_route`-style
action if SAAR buffer is active).

### Downgrade (pinned frontier → economical)
Requires ALL:
- scorer `targetTier === 'economical-cloud'` with high confidence.
- **lightweight streak** counter on the pin ≥ `MIN_LIGHTWEIGHT_STREAK` (proposed 3)
  consecutive light turns.
- **cooldown / minimum dwell**: at least `MIN_DWELL_MS` (proposed 5 min) since the
  last upgrade, to avoid immediate drop after a single heavy turn.
- cache re-prime cost acceptable (`evaluateCacheBreakeven` or capability-weighted equivalent).
- `FlipFlopGuard` does not block.

Returns `{ action: 'use_pin', pinnedModel: economicalCandidate }`.

### Ambiguous / low confidence
Return `null` → `lookupPin` falls through to the default `use_pin` (pin held).
This is the core anti-flip-flop guarantee.

### State and persistence
`lightweight_streak` is an in-memory counter keyed by session id. It resets when
the process restarts, the pin changes, or the pin breaks; reset-on-restart is
conservative because it delays a downgrade rather than causing one. Minimum dwell
uses the existing persisted `SessionPin.updated_at`, which is refreshed whenever a
complexity upgrade or downgrade records a new pin. New audit values
`complexity_upgrade` and `complexity_downgrade` are added to `PinReason`, Zod, and
the SQLite `pins` CHECK constraint through a version-6 table-rebuild migration.

---

## Interaction with existing logic

| Existing | Interaction |
|---|---|
| `evaluateBreakRules` (compaction/overflow/cache) | runs first; hard breaks take priority |
| `computeOutputHeadroom` (delegation) | unchanged; still catches true overflow at dispatch |
| SAAR policy | unchanged; higher priority for buffer/hard-lock cases |
| `sub_routing` (tool_result) | unchanged; tool results still sub-route to economical |
| `FlipFlopGuard` | reused to block rapid tier oscillation |
| `evaluateModelSwitchBreakeven` | reused; extended with capability-weight term |

---

## Data flow

```
Pi host → RoutingRequest(context.messages)
  → extension buildRoutingRequest → turn_type = deriveTurnType(...)
  → RouterPipeline stages … → session_pin stage
      → SessionPinner.lookupPin(request, fleet)
          → evaluateBreakRules        (hard)
          → evaluateComplexitySwitch  (NEW)
              → complexity-scorer.score(request, pin, fleet)
              → upgrade / downgrade / null
          → SAAR / sub_routing / default
      → decision (selected_model_id, pin_reason)
  → route-and-delegate → dispatch
```

`pin_reason` gains values like `complexity_upgrade` / `complexity_downgrade` for
telemetry and `SMART_ROUTER_LOG_ROUTING=1` explainability.

---

## Edge cases

- **Compaction mid-session:** break rule fires first → pin cleared → re-route from
  scratch (unchanged). Complexity switching only acts on a live, healthy pin.
- **Model unhealthy:** `lookupPin` finds no healthy pinned model → `no_pin` → normal
  route. Complexity switching never forces an unhealthy model.
- **Confidence low (e.g. `planning` keyword but 1-line prompt):** `targetTier = null`
  → pin held (no false upgrade).
- **Missing component price rates:** use the existing `fallback_cost_per_1m` for both
  input and output, so scoring remains deterministic for catalog-only models.

---

## Testing

**Unit**
- `complexity-scorer`: known prompts → expected score/tier/confidence
  (youtube-summary → light; architect-50-services → heavy; "plan besok" → low conf).
- `evaluateComplexitySwitch`: upgrade path, downgrade path (streak + cooldown),
  ambiguous → hold, flip-flop block.
- Cost: weighted-cost vs mean-cost difference (luna cheaper than hy3 at I≫O).

**Integration**
- Replay the real session shape: hy3-free → overflow → gpt-5.6-luna → compaction →
  hy3-free. Assert pin reasons are correct.
- New scenario: heavy planning turn → upgrade; then 3 light turns → downgrade
  (without waiting for compaction).

**Regression**
- Keep the existing suite green (currently 1863 tests). Add Plan B tests as a new
  unit file; do not modify unrelated tests.

---

## Risks / open questions

1. **Threshold tuning** — initial 0.70/0.30/0.60 and 3-streak/5-min are guesses;
   need telemetry validation before release.
2. **Capability-weight calibration** — initial formula uses reasoning as the primary
   signal and context-window headroom as a secondary signal; telemetry may tune the
   weights, but any revision must remain monotonic and covered by unit tests.
3. **Scoring latency** — scorer must stay <2ms (regex only, no model call).
4. **Interaction with SAAR buffer** — confirm SAAR planning-buffer and complexity
   upgrade don't double-count; SAAR stays priority.

---

## Implementation files (proposed)

- `src/domain/routing/complexity-scorer.ts` — new pure module.
- `src/domain/pinning/session-pinner.ts` — add `evaluateComplexitySwitch()`,
  lightweight-streak + dwell tracking on `SessionPin`, new `pin_reason` values.
- `src/domain/types/entities.ts` / schemas — extend `PinReason` if needed.
- `src/config/pi-model-mapper.ts` — retain normalized input/output rates and Pi
  context/output limits while mapping the registry fleet.
- `.pi/extensions/smart-router/fleet-bootstrap.ts` — pass `contextWindow` and
  `maxTokens` from Pi registry models into the mapper.
- `src/domain/types/entities.ts` / `src/domain/types/schemas.ts` — add component
  price rates, complexity pin reasons, and scorer config types.
- `src/infrastructure/persistence/sqlite-store.ts` — version-6 migration for the
  two new pin-reason values; no new persistence column is required.
- Tests: `tests/unit/complexity-scorer.test.ts`,
  `tests/unit/session-pinner-complexity.test.ts`, mapper and SQLite-store regressions.

No changes to the published package API surface beyond the new internal behavior.
