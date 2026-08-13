# Plan B Complexity Rescore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic per-request complexity re-scoring that can upgrade economical session pins for justified heavy turns and downgrade frontier pins after sustained light turns, while preserving KV-cache economics, hard break rules, SAAR, and tool-result sub-routing.

**Architecture:** Keep pin decisions in `SessionPinner`, where existing break rules, SAAR, cache economics, persistence, and `FlipFlopGuard` already live. Add a pure `complexity-scorer.ts` for request signals, weighted cost, candidate selection, and capability-gap reporting; `SessionPinner.evaluateComplexitySwitch()` consumes that result and owns streak, dwell, and switch persistence. Carry Pi registry context limits and component input/output prices into `ModelProfile` before scoring.

**Tech Stack:** TypeScript, Zod, Vitest, SQLite via `better-sqlite3`, existing `ModelProfile`/`RoutingRequest`/`StorePort` abstractions.

**Spec:** `docs/specs/2026-08-13-plan-b-complexity-rescore-design.md`

## Global Constraints

- Keep `smart-router/auto` selectable in Pi but excluded from delegation targets.
- Preserve hard break priority: compaction, context overflow, unhealthy models, explicit force, cache economics, and existing emergency rules remain authoritative.
- Preserve SAAR policy and `tool_result` sub-routing; never persistently switch the pin because of a `tool_result` turn.
- Do not make an additional model or LLM call for classification.
- Keep the scorer deterministic, bounded, and lightweight; prompt scanning must use a small fixed regex set and no unbounded history traversal.
- Use weighted request cost: `(input_tokens / 1M) * input_rate + (output_tokens / 1M) * output_rate`.
- Estimate output tokens as `ceil(input_tokens * output_to_input_ratio)`, default ratio `0.05`, clamped to `[0, 0.05]`; do not add a cost floor.
- Preserve KV-cache benefits and use hysteresis: upgrade requires confidence and capability/economic justification; downgrade requires three light turns and a five-minute dwell by default.
- Do not change the published package API surface beyond internal routing behavior.
- Run targeted tests after each task and obtain explicit approval before each git commit.

---

## File and Dependency Map

| File | Responsibility in this plan |
|---|---|
| `src/domain/types/entities.ts` | Store component price rates and new pin reasons in domain types. |
| `src/domain/types/schemas.ts` | Validate new pin reasons and complexity configuration. |
| `src/config/pi-model-mapper.ts` | Convert Pi registry prices and limits into `ModelProfile`. |
| `.pi/extensions/smart-router/fleet-bootstrap.ts` | Pass Pi `contextWindow`/`maxTokens` and complexity config into routing. |
| `src/domain/routing/complexity-scorer.ts` | Pure scoring, output estimate, weighted cost, capability gap, and candidate selection. |
| `src/domain/pinning/session-pinner.ts` | Apply complexity switch rules, streak, dwell, cache gate, and pin persistence. |
| `src/domain/pipeline/router-pipeline.ts` | Surface complexity switch reason codes in routing decisions and avoid treating them as initial-pin persistence. |
| `src/infrastructure/persistence/sqlite-store.ts` | Version-6 pin CHECK-constraint migration. |
| `tests/unit/pi-model-mapper.test.ts` | Mapper pricing and limit regressions. |
| `tests/unit/complexity-config.test.ts` | Complexity schema, defaults, and environment overrides. |
| `tests/unit/complexity-scorer.test.ts` | Pure scorer behavior and cost math. |
| `tests/unit/session-pinner-complexity.test.ts` | Upgrade, downgrade, hysteresis, and hard-policy interactions. |
| `tests/unit/sqlite-store.test.ts` | Migration and persistence compatibility. |
| `tests/integration/complexity-switch.test.ts` | Realistic session sequence through the pinner/store boundary. |

---

## Task 1: Carry Component Prices and Pi Limits into Model Profiles

**Files:**
- Modify: `src/domain/types/entities.ts:ModelPricing`
- Modify: `src/config/pi-model-mapper.ts:PiModelInput`, `buildProfile`, and price helpers
- Modify: `.pi/extensions/smart-router/fleet-bootstrap.ts:registryModelsToFleetInput`
- Test: `tests/unit/pi-model-mapper.test.ts`

**Interfaces:**
- Consumes: Pi `Model<Api>` entries containing `cost.input`, `cost.output`, `contextWindow`, and `maxTokens`.
- Produces: `ModelProfile.pricing.input_rate_per_1m`, `ModelProfile.pricing.output_rate_per_1m`, and `ModelProfile.limits.max_input_tokens/max_output_tokens`.

- [ ] **Step 1: Write failing mapper tests for component rates and limits.**

Add tests using the existing `makeInput` helper:

```ts
it('retains separate normalized input and output rates', () => {
  const profile = mapPiModelToProfile({
    provider: 'openai',
    id: 'gpt-5.6-luna',
    cost: {
      input: 0.10 / 1_000_000,
      output: 0.60 / 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    },
  });

  expect(profile.pricing.input_rate_per_1m).toBeCloseTo(0.10);
  expect(profile.pricing.output_rate_per_1m).toBeCloseTo(0.60);
  expect(profile.pricing.fallback_cost_per_1m).toBeCloseTo(0.35);
});

it('carries Pi context and output limits into the profile', () => {
  const profile = mapPiModelToProfile({
    provider: 'openai',
    id: 'gpt-5.6-luna',
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  });

  expect(profile.limits).toEqual({
    max_input_tokens: 1_000_000,
    max_output_tokens: 16_384,
  });
});

it('falls back to the existing mean only when component rates are absent', () => {
  const profile = mapPiModelToProfile({
    provider: 'openai',
    id: 'gpt-5-mini',
  });

  expect(profile.pricing.input_rate_per_1m).toBeUndefined();
  expect(profile.pricing.output_rate_per_1m).toBeUndefined();
  expect(profile.pricing.fallback_cost_per_1m).toBe(0.8);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```bash
npm test -- tests/unit/pi-model-mapper.test.ts
```

Expected: FAIL because `ModelPricing` has no component-rate fields and `PiModelInput` has no context-limit fields.

- [ ] **Step 3: Add the domain and mapper fields.**

Extend `ModelPricing`:

```ts
readonly input_rate_per_1m?: number | undefined;
readonly output_rate_per_1m?: number | undefined;
```

Extend `PiModelInput`:

```ts
readonly contextWindow?: number;
readonly maxTokens?: number;
```

In `buildProfile`, normalize non-zero Pi rates by multiplying each per-token rate by `1_000_000`. Preserve the existing arithmetic mean in `fallback_cost_per_1m` for compatibility with existing frugality paths. Add `limits` only when at least one valid Pi limit is supplied:

```ts
const limits =
  input.contextWindow !== undefined || input.maxTokens !== undefined
    ? {
        ...(input.contextWindow !== undefined
          ? { max_input_tokens: input.contextWindow }
          : {}),
        ...(input.maxTokens !== undefined
          ? { max_output_tokens: input.maxTokens }
          : {}),
      }
    : undefined;
```

Component rates must be omitted when both registry rates are zero, allowing the scorer to use `fallback_cost_per_1m` for legacy/catalog-only entries. Keep local-provider handling unchanged so local models remain free.

In `registryModelsToFleetInput`, pass `model.contextWindow` and `model.maxTokens` alongside the existing cost object.

- [ ] **Step 4: Run mapper, price-broker, and type tests.**

Run:

```bash
npm test -- tests/unit/pi-model-mapper.test.ts tests/unit/price-broker.test.ts
npm run typecheck
```

Expected: PASS. Confirm that `applyCatalogLimitsToFleet` continues to prefer profile-provided limits before catalog/tier defaults and that catalog price spreading preserves component rates.

- [ ] **Step 5: Review the diff and request approval before committing.**

Run:

```bash
git diff -- src/domain/types/entities.ts src/config/pi-model-mapper.ts .pi/extensions/smart-router/fleet-bootstrap.ts tests/unit/pi-model-mapper.test.ts
git status --short
```

After Lae Cokky approves, commit:

```bash
git add src/domain/types/entities.ts src/config/pi-model-mapper.ts \
  .pi/extensions/smart-router/fleet-bootstrap.ts tests/unit/pi-model-mapper.test.ts
git commit -m "feat: retain component prices and Pi model limits"
```

---

## Task 2: Add Complexity Configuration and Pin-Reason Types

**Files:**
- Modify: `src/domain/types/entities.ts:PinReason`
- Modify: `src/domain/types/schemas.ts:PinReasonSchema` and `OperatorConfigSchema`
- Modify: `src/config/defaults.ts`
- Test: `tests/unit/complexity-config.test.ts` (create)

**Interfaces:**
- Consumes: Existing Zod configuration conventions and `OperatorConfig` defaults.
- Produces: `ComplexityScorerConfig`, `DEFAULT_COMPLEXITY_SCORER_CONFIG`, and two valid pin reasons: `complexity_upgrade` and `complexity_downgrade`.

- [ ] **Step 1: Write failing schema/default tests.**

Create `tests/unit/complexity-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ComplexityScorerConfigSchema,
  OperatorConfigSchema,
  PinReasonSchema,
} from '../../src/domain/types/schemas.js';

it('uses conservative complexity defaults', () => {
  expect(ComplexityScorerConfigSchema.parse({})).toMatchObject({
    output_to_input_ratio: 0.05,
    upgrade_score_threshold: 0.7,
    downgrade_score_threshold: 0.3,
    confidence_threshold: 0.6,
    min_lightweight_streak: 3,
    min_dwell_ms: 300_000,
    capability_override_gap: 0.15,
  });
});

it('rejects output ratios above five percent', () => {
  expect(() =>
    ComplexityScorerConfigSchema.parse({ output_to_input_ratio: 0.0501 }),
  ).toThrow();
});

it('accepts complexity pin reasons and includes config in operator config', () => {
  expect(PinReasonSchema.parse('complexity_upgrade')).toBe('complexity_upgrade');
  expect(PinReasonSchema.parse('complexity_downgrade')).toBe('complexity_downgrade');
  expect(OperatorConfigSchema.parse({}).complexity_scorer).toBeDefined();
});
```

- [ ] **Step 2: Run the config tests and verify they fail.**

Run:

```bash
npm test -- tests/unit/complexity-config.test.ts
```

Expected: FAIL because the schema and pin reasons do not exist.

- [ ] **Step 3: Add schema fields and defaults.**

Add `ComplexityScorerConfigSchema` with these exact fields and export the default from the schema module so the pure scorer does not import the application config module:

```ts
export const ComplexityScorerConfigSchema = z.object({
  output_to_input_ratio: z.number().min(0).max(0.05).default(0.05),
  upgrade_score_threshold: z.number().min(0).max(1).default(0.7),
  downgrade_score_threshold: z.number().min(0).max(1).default(0.3),
  confidence_threshold: z.number().min(0).max(1).default(0.6),
  min_lightweight_streak: z.number().int().min(1).max(10).default(3),
  min_dwell_ms: z.number().int().min(0).default(300_000),
  capability_override_gap: z.number().min(0).max(1).default(0.15),
});

export type ComplexityScorerConfig = z.infer<typeof ComplexityScorerConfigSchema>;
export const DEFAULT_COMPLEXITY_SCORER_CONFIG = ComplexityScorerConfigSchema.parse({});
```

Add `complexity_upgrade` and `complexity_downgrade` to both `PinReasonSchema` and the `PinReason` union in `entities.ts`.

Add `complexity_scorer: ComplexityScorerConfigSchema.default({})` to `OperatorConfigSchema`. Re-export `DEFAULT_COMPLEXITY_SCORER_CONFIG` from `src/config/defaults.ts` and add it to `DEFAULT_OPERATOR_CONFIG`.

Add this environment resolver in `src/config/defaults.ts`:

```ts
export function resolveComplexityScorerConfigFromEnv(
  base: ComplexityScorerConfig = DEFAULT_COMPLEXITY_SCORER_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): ComplexityScorerConfig {
  const numberOverride = (
    name: string,
    current: number,
    min: number,
    max: number,
    integer = false,
  ): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return current;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return current;
    if (integer && !Number.isInteger(value)) return current;
    return value;
  };

  return ComplexityScorerConfigSchema.parse({
    output_to_input_ratio: numberOverride('SMART_ROUTER_COMPLEXITY_OUTPUT_RATIO', base.output_to_input_ratio, 0, 0.05),
    upgrade_score_threshold: numberOverride('SMART_ROUTER_COMPLEXITY_UPGRADE_THRESHOLD', base.upgrade_score_threshold, 0, 1),
    downgrade_score_threshold: numberOverride('SMART_ROUTER_COMPLEXITY_DOWNGRADE_THRESHOLD', base.downgrade_score_threshold, 0, 1),
    confidence_threshold: numberOverride('SMART_ROUTER_COMPLEXITY_CONFIDENCE_THRESHOLD', base.confidence_threshold, 0, 1),
    min_lightweight_streak: numberOverride('SMART_ROUTER_COMPLEXITY_MIN_STREAK', base.min_lightweight_streak, 1, 10, true),
    min_dwell_ms: numberOverride('SMART_ROUTER_COMPLEXITY_MIN_DWELL_MS', base.min_dwell_ms, 0, Number.MAX_SAFE_INTEGER, true),
    capability_override_gap: numberOverride('SMART_ROUTER_COMPLEXITY_CAPABILITY_GAP', base.capability_override_gap, 0, 1),
  });
}
```

Invalid or out-of-range values leave the corresponding base value unchanged.

- [ ] **Step 4: Test environment resolution and typecheck.**

Add assertions for valid overrides and invalid-value preservation, then run:

```bash
npm test -- tests/unit/complexity-config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Review and request approval before committing.**

After approval:

```bash
git add src/domain/types/entities.ts src/domain/types/schemas.ts \
  src/config/defaults.ts tests/unit/complexity-config.test.ts
git commit -m "feat: add complexity routing configuration"
```

---

## Task 3: Implement the Pure Complexity Scorer

**Files:**
- Create: `src/domain/routing/complexity-scorer.ts`
- Test: `tests/unit/complexity-scorer.test.ts`

**Interfaces:**
- Consumes: `RoutingRequest`, healthy `ModelProfile` fleet, and `ComplexityScorerConfig`.
- Produces: `ComplexityScore`, `estimateOutputTokens()`, `estimateWeightedCostUsd()`, and `selectComplexityCandidate()` for `SessionPinner`.

- [ ] **Step 1: Write failing pure scorer tests.**

Create fixtures for economical `hy3-free`, paid economical `hy3`, and frontier `gpt-5.6-luna`. Include explicit `limits` and component rates. Cover:

```ts
it('uses a five-percent output estimate without a cost floor', () => {
  expect(estimateOutputTokens(100_000, { output_to_input_ratio: 0.05 })).toBe(5_000);
  expect(estimateOutputTokens(1, { output_to_input_ratio: 0.05 })).toBe(1);
  expect(estimateOutputTokens(0, { output_to_input_ratio: 0.05 })).toBe(0);
});

it('uses weighted input/output pricing rather than the arithmetic mean', () => {
  const luna = makeModel({
    input_rate_per_1m: 0.10,
    output_rate_per_1m: 0.60,
  });
  const hy3 = makeModel({
    input_rate_per_1m: 0.12,
    output_rate_per_1m: 0.53,
  });

  expect(estimateWeightedCostUsd(luna, 100_000, 5_000))
    .toBeCloseTo(0.013, 6);
  expect(estimateWeightedCostUsd(hy3, 100_000, 5_000))
    .toBeCloseTo(0.01465, 6);
});

it('keeps a short summary request below the frontier upgrade threshold', () => {
  const result = scoreComplexity(makeRequest('buat ringkasan dari link youtube', 500), econPin, fleet);
  expect(result.score).toBeLessThan(0.7);
  expect(result.targetTier).toBeNull();
});

it('recognizes a long architecture/refactor request as frontier-worthy', () => {
  const result = scoreComplexity(makeRequest(heavyArchitecturePrompt, 150_000), econPin, fleet);
  expect(result.score).toBeGreaterThanOrEqual(0.7);
  expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  expect(result.targetTier).toBe('frontier-cloud');
});

it('does not upgrade a short planning keyword with low confidence', () => {
  const result = scoreComplexity(makeRequest('plan besok mau apa', 32, 'planning'), econPin, fleet);
  expect(result.confidence).toBeLessThan(0.6);
  expect(result.targetTier).toBeNull();
});

it('returns a downgrade suggestion for a light request on a frontier pin', () => {
  const result = scoreComplexity(makeRequest('ok, cukup', 1_000), frontierPin, fleet);
  expect(result.targetTier).toBe('economical-cloud');
});
```

Use a long architecture fixture for the heavy test so context pressure is represented honestly; do not make a one-line keyword the sole reason for an upgrade.

- [ ] **Step 2: Run the scorer tests and verify they fail.**

Run:

```bash
npm test -- tests/unit/complexity-scorer.test.ts
```

Expected: FAIL because the scorer module and exported functions do not exist.

- [ ] **Step 3: Implement the pure module.**

Export these exact interfaces and functions:

```ts
export interface ComplexityScore {
  readonly score: number;
  readonly confidence: number;
  readonly targetTier: Tier | null;
  readonly direction: 'upgrade' | 'downgrade' | null;
  readonly candidate_model_id: string | null;
  readonly estimated_output_tokens: number;
  readonly estimated_cost_pinned_usd: number;
  readonly estimated_cost_candidate_usd: number;
  readonly capability_gap: number;
  readonly reasons: readonly string[];
}

export interface ComplexityScorerInput {
  readonly request: RoutingRequest;
  readonly pinnedModel: ModelProfile;
  readonly fleet: readonly ModelProfile[];
  readonly config?: Partial<ComplexityScorerConfig>;
}

export function estimateOutputTokens(
  inputTokens: number,
  config: Pick<ComplexityScorerConfig, 'output_to_input_ratio'>,
): number;

export function estimateWeightedCostUsd(
  model: ModelProfile,
  inputTokens: number,
  outputTokens: number,
): number;

export function selectComplexityCandidate(
  fleet: readonly ModelProfile[],
  targetTier: Tier,
  inputTokens: number,
  outputTokens: number,
): ModelProfile | null;

export function scoreComplexity(input: ComplexityScorerInput): ComplexityScore;
```

Implement these rules:

1. Use `estimated_input_tokens`, falling back to `prompt_text.length` exactly as existing context-fit code does.
2. Estimate output with `ceil(input * ratio)` and clamp the ratio to `[0, 0.05]`.
3. Resolve component rates independently; when a component is absent, use `fallback_cost_per_1m` for that component.
4. Select only healthy models in the opposite tier: frontier when the pin is economical/zero-tier, economical when the pin is frontier. Filter candidates that cannot fit the estimated input in their `limits.max_input_tokens`; if no candidate has a declared limit, retain the candidate.
5. Choose the candidate with lowest weighted request cost; tie-break by higher `capabilities.reasoning`, then lexical model id.
6. Compute signals with fixed bounded work:
   - `contextPressure = clamp(inputTokens / max(pinned.max_input_tokens ?? inputTokens, 1))`.
   - `turnSignal = 1` for `planning`, `0` for `tool_result`/`subagent`, and `0.5` otherwise.
   - `heuristicSignal = clamp(0.5 + 0.15 * (heavyHits - lightHits))`, using fixed regexes for code blocks, architecture/refactor/migration/debug/error/test markers, and summary/acknowledgement/simple markers.
   - `costSignal = clamp(0.5 + 0.5 * ((pinnedCost - candidateCost) / max(pinnedCost, 1e-9)))`.
   - `heavyEvidence = max(contextPressure, heuristicSignal, turnSignal)`.
   - `capabilitySignal = clamp(0.5 + 1.5 * capabilityGap)` only for an upgrade; for a downgrade use `clamp(0.5 + 1.5 * -capabilityGap)` so a near-equivalent economical candidate is safer than a substantially weaker one.
   - `capabilityContribution = heavyEvidence >= 0.65 ? capabilitySignal : 0.5`.
   - For upgrade, use `costSignal`; for downgrade, use `1 - costSignal` so a cheaper economical candidate lowers frontier-worthiness.
7. Compute the request score with this exact deterministic formula:

```ts
const score = clamp01(
  0.35 * contextPressure +
  0.20 * turnSignal +
  0.20 * heuristicSignal +
  0.15 * capabilityContribution +
  0.10 * directionAwareCostSignal,
);
```

The scorer returns the exact unnormalized `capability_gap` separately. The capability contribution is gated by `heavyEvidence`, preventing a frontier model's capability from making every short request appear complex while still allowing capability to strengthen a clearly heavy request.

8. Compute confidence from five non-contradiction checks: context direction, turn direction, heuristic direction, capability direction, and alternative cost direction. Use `0.6 * agreementFraction + 0.4 * clamp(inputTokens / 25_000)`. This makes a short ambiguous planning keyword low confidence even if `turn_type` says `planning`.
9. Return `targetTier: 'frontier-cloud'` only when score `>= upgrade_score_threshold` and confidence `>= confidence_threshold`; return `targetTier: 'economical-cloud'` only when score `<= downgrade_score_threshold` and confidence meets the same threshold; otherwise return `null`.
10. Return explainable reason strings for each dominant signal, candidate absence, and threshold result. Do not log from the pure module.

- [ ] **Step 4: Run pure scorer tests, lint, and typecheck.**

Run:

```bash
npm test -- tests/unit/complexity-scorer.test.ts
npm run lint -- --no-fix
npm run typecheck
```

Expected: PASS with no new lint/type errors.

- [ ] **Step 5: Review and request approval before committing.**

After approval:

```bash
git add src/domain/routing/complexity-scorer.ts tests/unit/complexity-scorer.test.ts
git commit -m "feat: add deterministic complexity scorer"
```

---

## Task 4: Add Complexity Switching to SessionPinner

**Files:**
- Modify: `src/domain/pinning/session-pinner.ts`
- Test: `tests/unit/session-pinner-complexity.test.ts`

**Interfaces:**
- Consumes: `scoreComplexity()`, `selectComplexityCandidate()`, existing `evaluateModelSwitchBreakeven()`, `FlipFlopGuard`, `SessionPin`, and `SessionPinnerConfig`.
- Produces: `PinLookupResult` with a newly persisted `complexity_upgrade` or `complexity_downgrade` pin.

- [ ] **Step 1: Write failing pinner tests.**

Create tests with injectable `complexityClock` and a `MemoryStore` where persistence is relevant:

```ts
it('upgrades an economical pin for one high-confidence heavy request', () => {
  const pinner = makePinner({ now: () => now });
  pinner.recordPin('s1', 'hy3-paid', 'initial');

  const result = pinner.lookupPin(heavyRequest('s1'), fleet);

  expect(result.action).toBe('use_pin');
  expect(result.pinnedModel?.tier).toBe('frontier-cloud');
  expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_upgrade');
});

it('requires three light turns and minimum dwell before downgrade', () => {
  const pinner = makePinner({ now: () => now });
  pinner.recordPin('s1', 'gpt-5.6-luna', 'initial');

  expect(lightLookup(pinner, 's1').pinnedModel?.id).toBe('gpt-5.6-luna');
  expect(lightLookup(pinner, 's1').pinnedModel?.id).toBe('gpt-5.6-luna');
  expect(lightLookup(pinner, 's1').pinnedModel?.id).toBe('gpt-5.6-luna');

  now += 300_001;
  const result = lightLookup(pinner, 's1');

  expect(result.pinnedModel?.tier).toBe('economical-cloud');
  expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_downgrade');
});

it('holds on ambiguous scores and resets the light streak on a pin change', () => {
  const pinner = makePinner({ now: () => now });
  pinner.recordPin('s1', 'gpt-5.6-luna', 'initial');

  const result = pinner.lookupPin(shortPlanningRequest('s1'), fleet);

  expect(result.pinnedModel?.id).toBe('gpt-5.6-luna');
  expect(pinner.getPin('s1')?.pin_reason).toBe('initial');
});

it('never persistently switches on a tool result', () => {
  const pinner = makePinner({ now: () => now });
  pinner.recordPin('s1', 'gpt-5.6-luna', 'initial');

  const result = pinner.lookupPin(toolResultRequest('s1'), fleet);

  expect(['sub_route', 'use_pin']).toContain(result.action);
  expect(pinner.getPin('s1')?.pinned_model_id).toBe('gpt-5.6-luna');
});

it('keeps hard compaction and overflow breaks ahead of complexity scoring', () => {
  const pinner = makePinner({ now: () => now });
  pinner.recordPin('s1', 'hy3-paid', 'initial');

  const result = pinner.lookupPin({ ...heavyRequest('s1'), compaction_flag: true }, fleet);

  expect(result).toEqual({ action: 'break', breakReason: 'compaction' });
  expect(pinner.getPin('s1')).toBeNull();
});
```

- [ ] **Step 2: Run the pinner tests and verify they fail.**

Run:

```bash
npm test -- tests/unit/session-pinner-complexity.test.ts
```

Expected: FAIL because `SessionPinnerConfig` has no complexity clock/config and `lookupPin` has no complexity switch path.

- [ ] **Step 3: Add config, state, and lookup ordering.**

Extend `SessionPinnerConfig` with:

```ts
readonly complexityScorerConfig?: ComplexityScorerConfig;
readonly complexityClock?: () => number;
```

Add private state:

```ts
private readonly complexityScorerConfig: ComplexityScorerConfig;
private readonly complexityClock: () => number;
private readonly lightweightStreaks = new Map<string, number>();
```

Initialize config from `ComplexityScorerConfigSchema.parse(config?.complexityScorerConfig ?? {})` and default the clock to `Date.now`.

Insert complexity evaluation after `evaluateSaarPolicy()` and before `evaluateSubRouting()`. The method must immediately return `null` for `tool_result`, `force_model_id`, no pin, unhealthy pinned model, or an active higher-priority SAAR result.

- [ ] **Step 4: Implement `evaluateComplexitySwitch()`.**

Add the private method with this behavior:

```ts
private evaluateComplexitySwitch(
  request: RoutingRequest,
  pin: SessionPin,
  fleet: readonly ModelProfile[],
): PinLookupResult | null
```

1. Resolve the healthy pinned model. If absent, return `null` and allow existing fallback behavior.
2. Call `scoreComplexity({ request, pinnedModel, fleet, config: this.complexityScorerConfig })`.
3. For `targetTier === 'frontier-cloud'`:
   - Reset the light streak.
   - Reject if the candidate is missing, does not fit the request, is blocked by `FlipFlopGuard`, or the request is a `tool_result`.
   - Run `evaluateModelSwitchBreakeven()` with the current token estimate and warm-prefix estimate already used by the pinner.
   - Permit the upgrade when breakeven passes **or** the candidate has a reasoning gap `>= capability_override_gap` **or** a strictly larger `max_input_tokens` window that prevents imminent context pressure.
   - Call `recordPin(sessionId, candidate.id, 'complexity_upgrade')` and return `{ action: 'use_pin', pinnedModel: candidate }`.
4. For `targetTier === 'economical-cloud'`:
   - Increment the in-memory streak for the session.
   - Reject until streak `>= min_lightweight_streak`.
   - Reject until `complexityClock() - Date.parse(pin.updated_at) >= min_dwell_ms`.
   - Reject if candidate is missing, does not fit, or `FlipFlopGuard` blocks the tier.
   - Require `evaluateModelSwitchBreakeven()` to pass. This preserves KV-cache and cache re-prime economics; no unpriced downgrade is allowed.
   - Call `recordPin(sessionId, candidate.id, 'complexity_downgrade')` and return `{ action: 'use_pin', pinnedModel: candidate }`.
5. For `targetTier === null`, do not change the pin. Do not increment the downgrade streak for low-confidence/ambiguous results; only a confidence-qualified economical target is a light streak turn.
6. Reset the streak in `recordPin()` when the model changes and in `breakPin()`. A process restart naturally resets the map and therefore delays, rather than accelerates, a downgrade.

Do not add a new persistence column. `SessionPin.updated_at` supplies the dwell timestamp, and the pin reason records the audit reason.

- [ ] **Step 5: Run pinner and existing session-pinner tests.**

Run:

```bash
npm test -- tests/unit/session-pinner-complexity.test.ts tests/unit/session-pinner.test.ts
npm run typecheck
```

Expected: PASS. Verify existing cache economics, SAAR, flip-flop, force, compaction, overflow, and sub-routing tests remain green.

- [ ] **Step 6: Review and request approval before committing.**

After approval:

```bash
git add src/domain/pinning/session-pinner.ts tests/unit/session-pinner-complexity.test.ts
git commit -m "feat: add complexity-aware session pin switching"
```

---

## Task 5: Persist New Pin Reasons through SQLite Version 6

**Files:**
- Modify: `src/infrastructure/persistence/sqlite-store.ts`
- Test: `tests/unit/sqlite-store.test.ts`

**Interfaces:**
- Consumes: Existing version-5 `pins` table and `SessionPin` entity.
- Produces: Schema version 6 that accepts `complexity_upgrade` and `complexity_downgrade` while preserving all existing pins.

- [ ] **Step 1: Write failing migration tests.**

Add tests that create a store, insert pins with both new reasons, close/reopen the store, and verify the values round-trip. Also create a version-5 database fixture with an existing `cache_economics` pin and verify it survives migration.

```ts
it('persists complexity pin reasons after migration/reopen', async () => {
  const store = makeSqliteStore();
  await store.putSessionPin(makePin('upgrade', 'complexity_upgrade'));
  await store.putSessionPin(makePin('downgrade', 'complexity_downgrade'));
  store.close();

  const reopened = makeSqliteStore();
  expect((await reopened.getSessionPin('upgrade'))?.pin_reason).toBe('complexity_upgrade');
  expect((await reopened.getSessionPin('downgrade'))?.pin_reason).toBe('complexity_downgrade');
  reopened.close();
});
```

- [ ] **Step 2: Run the SQLite tests and verify they fail.**

Run:

```bash
npm test -- tests/unit/sqlite-store.test.ts
```

Expected: FAIL because the current `pins` CHECK constraint rejects the new values.

- [ ] **Step 3: Add `MIGRATION_V6` and update migration sequencing.**

Set `CURRENT_SCHEMA_VERSION = 6`. Add a table-rebuild migration following the existing V5 pattern:

```sql
CREATE TABLE pins_v6 (
  session_id TEXT PRIMARY KEY,
  pinned_model_id TEXT NOT NULL,
  pin_reason TEXT NOT NULL CHECK (
    pin_reason IN (
      'initial','user_forced','loop_escalation','compaction',
      'cache_economics','context_overflow',
      'complexity_upgrade','complexity_downgrade'
    )
  ),
  has_ever_switched INTEGER NOT NULL DEFAULT 0,
  consecutive_upstream_errors INTEGER NOT NULL DEFAULT 0,
  consecutive_tool_failures INTEGER NOT NULL DEFAULT 0,
  last_tool_failure_signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO pins_v6 SELECT * FROM pins;
DROP TABLE pins;
ALTER TABLE pins_v6 RENAME TO pins;
```

Use an explicit column list in the production migration to avoid dependence on column order. Add `if (version < 6) { ...; version = 6; pragma user_version = 6; }` after the existing V5 block. Correct the V5 block to set version 5 explicitly if necessary; never set version 6 from the V5 branch.

- [ ] **Step 4: Run migration, persistence, and full SQLite tests.**

Run:

```bash
npm test -- tests/unit/sqlite-store.test.ts
```

Expected: PASS, including idempotency, old-pin preservation, new reason round-trips, and integrity checks.

- [ ] **Step 5: Review and request approval before committing.**

After approval:

```bash
git add src/infrastructure/persistence/sqlite-store.ts tests/unit/sqlite-store.test.ts
git commit -m "feat: migrate session pins for complexity reasons"
```

---

## Task 6: Wire Configuration and Routing Decision Reason Codes

**Files:**
- Modify: `.pi/extensions/smart-router/fleet-bootstrap.ts:createOperatorAwareSessionPinner`
- Modify: `src/config/defaults.ts:resolveOperatorConfigFromEnv`
- Modify: `src/domain/pipeline/router-pipeline.ts:sessionPin`
- Modify: `src/domain/pipeline/router-pipeline.ts:persistPinIfNeeded`
- Test: `tests/unit/router-pipeline.test.ts` or the closest existing pipeline test file

**Interfaces:**
- Consumes: `OperatorConfig.complexity_scorer`, `PinReason`, and `SessionPinner.lookupPin()` results.
- Produces: A configured pinner in the extension and decision reason codes `complexity_upgrade`/`complexity_downgrade` for telemetry/explain output.

- [ ] **Step 1: Add failing wiring/reason-code tests.**

Test that `createOperatorAwareSessionPinner()` receives the configured scorer thresholds, and that a pinner result whose current pin reason is `complexity_upgrade` produces a routing decision with reason code `complexity_upgrade`, not generic `session_pinned`.

Also verify `persistPinIfNeeded()` does not overwrite an already persisted complexity pin with `initial`.

- [ ] **Step 2: Run focused pipeline tests and verify failure.**

Run:

```bash
npm test -- tests/unit/router-pipeline.test.ts
```

Expected: FAIL because the extension does not pass complexity config and pipeline reason-code mapping only knows generic/Saar reasons.

- [ ] **Step 3: Wire the config and reason mapping.**

In `createOperatorAwareSessionPinner`, pass:

```ts
complexityScorerConfig: operatorConfig.complexity_scorer,
complexityClock: () => Date.now(),
```

In `resolveOperatorConfigFromEnv`, resolve the nested complexity config using `resolveComplexityScorerConfigFromEnv`.

In `router-pipeline.ts`, map the current pin reason before falling back to `session_pinned`:

```ts
const reasonCode =
  pin?.pin_reason === 'complexity_upgrade'
    ? 'complexity_upgrade'
    : pin?.pin_reason === 'complexity_downgrade'
      ? 'complexity_downgrade'
      : existingSaarAndFallbackReason;
```

Keep `tool_result_sub_route`, SAAR reasons, and pin-only fallback ahead of this mapping. Extend any reason-code union/schema only where the existing decision contract requires it. Update `persistPinIfNeeded()` to skip `complexity_upgrade` and `complexity_downgrade` decisions, because `SessionPinner.recordPin()` has already persisted them.

- [ ] **Step 4: Run focused pipeline and extension tests.**

Run:

```bash
npm test -- tests/unit/router-pipeline.test.ts tests/integration/pi-extension.test.ts
npm run typecheck
```

Expected: PASS with complexity reason codes visible in decisions and telemetry.

- [ ] **Step 5: Review and request approval before committing.**

After approval:

```bash
git add .pi/extensions/smart-router/fleet-bootstrap.ts \
  src/config/defaults.ts src/domain/pipeline/router-pipeline.ts \
  tests/unit/router-pipeline.test.ts
 git commit -m "feat: wire complexity routing into extension pipeline"
```

---

## Task 7: Add Session-Sequence Integration Coverage

**Files:**
- Create: `tests/integration/complexity-switch.test.ts`

**Interfaces:**
- Consumes: Real `SessionPinner`, `MemoryStore` or SQLite store, mapped model profiles, and existing break-rule behavior.
- Produces: Regression coverage for the intended session sequence and Plan B hysteresis.

- [ ] **Step 1: Write the integration scenarios.**

Scenario A must replay the known shape:

1. Pin economical `hy3-free` with reason `initial`.
2. Send an input that exceeds its mapped effective limit and assert `break/context_overflow`.
3. Record/select `gpt-5.6-luna` as the new pin.
4. Send `compaction_flag: true` and assert `break/compaction`.
5. Confirm the next route can create a fresh economical pin.

Scenario B must exercise Plan B without compaction:

1. Start with economical pin.
2. Send one high-confidence heavy request and assert `complexity_upgrade`.
3. Send two light requests and assert the frontier pin remains.
4. Advance the injected clock beyond five minutes.
5. Send the third qualifying light request and assert `complexity_downgrade`.
6. Send an ambiguous planning keyword and assert the current pin remains unchanged.

Use the real mapped limits and component rates from Task 1 rather than manually bypassing `ModelProfile.limits`.

- [ ] **Step 2: Run the integration test and verify it fails before final wiring.**

Run:

```bash
npm test -- tests/integration/complexity-switch.test.ts
```

Expected during implementation: failures identify any mismatch between scorer, pinner, mapper limits, persistence, and pipeline reason mapping. Resolve those failures only in the files assigned by the earlier tasks; do not weaken assertions.

- [ ] **Step 3: Run the integration test to green.**

Run:

```bash
npm test -- tests/integration/complexity-switch.test.ts
```

Expected: PASS for both session sequences, including persisted pin reasons and reset behavior after hard breaks.

- [ ] **Step 4: Review and request approval before committing.**

After approval:

```bash
git add tests/integration/complexity-switch.test.ts
git commit -m "test: cover complexity switching session sequences"
```

---

## Task 8: Full Verification and Release Readiness Review

**Files:**
- Modify only if verification exposes an implementation defect in the files above.
- Test: complete existing test suite.

- [ ] **Step 1: Run targeted regression groups.**

```bash
npm test -- \
  tests/unit/complexity-config.test.ts \
  tests/unit/complexity-scorer.test.ts \
  tests/unit/session-pinner-complexity.test.ts \
  tests/unit/session-pinner.test.ts \
  tests/unit/pi-model-mapper.test.ts \
  tests/unit/sqlite-store.test.ts \
  tests/integration/complexity-switch.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run build, typecheck, and lint.**

```bash
npm run build
npm run typecheck
npm run lint
```

Expected: PASS with no generated source changes beyond normal build output.

- [ ] **Step 3: Run the full suite.**

```bash
VITEST_MAX_WORKERS=2 npm test
```

Expected: all existing tests plus the new Plan B tests pass. If the known unrelated SQLite outcome-retention tests fail because fixtures are older than the 30-day retention window, report those exact failures separately; do not alter their timestamps as part of this feature.

- [ ] **Step 4: Inspect the final diff and behavior contract.**

```bash
git status --short
git diff --stat main...HEAD
git diff --check main...HEAD
```

Review these invariants manually:

- `smart-router/auto` is still selectable but absent from delegation fleet.
- No complexity switch occurs before compaction/overflow/health/force handling.
- `tool_result` remains temporary sub-routing only.
- A single heavy turn can upgrade only when candidate fit and economic/capability justification pass.
- Downgrade requires three confidence-qualified light turns and five-minute dwell.
- Streak is not persisted and resets conservatively after restart, pin change, or break.
- Component price rates survive catalog-price application.
- Pi `contextWindow`/`maxTokens` take precedence over tier fallback limits.
- SQLite version 6 preserves old pins and accepts both new reasons.

- [ ] **Step 5: Prepare the implementation handoff without committing or publishing automatically.**

Report the verification commands and exact results. Do not create a release tag, publish npm, push, or commit any follow-up changes without Lae Cokky's explicit approval.

---

## Spec Coverage Checklist

- Per-request re-scoring: Task 3 + Task 4.
- Heavy-turn upgrade: Tasks 3, 4, and 7.
- Sustained-light downgrade: Tasks 3, 4, and 7.
- Hysteresis and ambiguous hold: Tasks 3 and 4.
- Weighted input/output pricing: Tasks 1 and 3.
- Five-percent bounded output estimate: Tasks 2 and 3.
- Capability gap and override: Tasks 3 and 4.
- Pi context-window propagation: Task 1.
- Hard break priority: Tasks 4 and 7.
- SAAR and tool-result preservation: Tasks 4 and 6.
- SQLite pin-reason migration: Task 5.
- Explainability/telemetry reason codes: Task 6.
- Unit, integration, regression, build, typecheck, and lint verification: Tasks 1–8.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-plan-b-complexity-rescore.md`.

Two execution options:

1. **Subagent-Driven** — dispatch a fresh worker per task and review between tasks.
2. **Inline Execution** — execute the tasks in this session with checkpoints.

Implementation remains blocked until the plan and the amended spec are approved. Git commits still require Lae Cokky's explicit approval.