/** Deterministic per-request complexity scorer (Plan B). Pure module. */
import type { ModelProfile, RoutingRequest, Tier } from '../types/index.js';
import type { ComplexityScorerConfig } from '../types/schemas.js';

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

const HEAVY = [
  /\b(architecture|architectural)\b/i, /\b(refactor|refactoring)\b/i,
  /\bmigration\b/i, /\bdebug\b/i, /\berror\b/i, /\btests?\b/i, /```/,
];
const LIGHT = [
  /\b(ok|okay|sip|done|selesai)\b/i,
  /\b(ringkas|ringkasan|summary|summarize)\b/i,
  /\b(cukup|enough|thanks|terima kasih)\b/i,
  /\b(ya|yes|tidak|no)\b/i,
];
const clamp = (n: number): number => Math.min(1, Math.max(0, n));

export function resolveInputTokens(request: RoutingRequest): number {
  return request.estimated_input_tokens ?? request.prompt_text.length;
}

export function estimateOutputTokens(
  inputTokens: number,
  config: Pick<ComplexityScorerConfig, 'output_to_input_ratio'>,
): number {
  const ratio = Math.min(0.05, Math.max(0, config.output_to_input_ratio));
  return Math.ceil(Math.max(0, inputTokens) * ratio);
}

export function estimateWeightedCostUsd(
  model: ModelProfile, inputTokens: number, outputTokens: number,
): number {
  const input = model.pricing.input_rate_per_1m ?? model.pricing.fallback_cost_per_1m;
  const output = model.pricing.output_rate_per_1m ?? model.pricing.fallback_cost_per_1m;
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

function healthy(model: ModelProfile): boolean { return model.healthy !== false; }
function fits(model: ModelProfile, inputTokens: number): boolean {
  return model.limits?.max_input_tokens === undefined ||
    inputTokens <= model.limits.max_input_tokens;
}

export function selectComplexityCandidate(
  fleet: readonly ModelProfile[], targetTier: Tier,
  inputTokens: number, outputTokens: number,
): ModelProfile | null {
  const candidates = fleet.filter((m) => m.tier === targetTier && healthy(m) && fits(m, inputTokens));
  return candidates.slice().sort((a, b) => {
    const cost = estimateWeightedCostUsd(a, inputTokens, outputTokens) -
      estimateWeightedCostUsd(b, inputTokens, outputTokens);
    if (cost !== 0) return cost;
    const reasoning = b.capabilities.reasoning - a.capabilities.reasoning;
    return reasoning !== 0 ? reasoning : a.id.localeCompare(b.id);
  })[0] ?? null;
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}
function capabilityGap(direction: 'upgrade' | 'downgrade', pinned: ModelProfile, candidate: ModelProfile | null): number {
  if (!candidate) return 0;
  return direction === 'upgrade'
    ? candidate.capabilities.reasoning - pinned.capabilities.reasoning
    : pinned.capabilities.reasoning - candidate.capabilities.reasoning;
}
function directionSignal(direction: 'upgrade' | 'downgrade', gap: number): number {
  return clamp(direction === 'upgrade' ? 0.5 + 1.5 * gap : 0.5 - 1.5 * gap);
}

export function scoreComplexity(input: ComplexityScorerInput): ComplexityScore {
  const config = {
    output_to_input_ratio: 0.05, upgrade_score_threshold: 0.7,
    downgrade_score_threshold: 0.3, confidence_threshold: 0.6,
    min_lightweight_streak: 3, min_dwell_ms: 300_000, capability_override_gap: 0.15,
    ...(input.config ?? {}),
  };
  const tokens = Math.max(0, resolveInputTokens(input.request));
  const outputTokens = estimateOutputTokens(tokens, config);
  const direction: 'upgrade' | 'downgrade' = input.pinnedModel.tier === 'frontier-cloud' ? 'downgrade' : 'upgrade';
  const targetTier: Tier = direction === 'upgrade' ? 'frontier-cloud' : 'economical-cloud';
  const candidate = selectComplexityCandidate(input.fleet, targetTier, tokens, outputTokens);
  const pressure = clamp(tokens / Math.max(input.pinnedModel.limits?.max_input_tokens ?? tokens, 1));
  const turn = input.request.turn_type === 'planning' ? 1 : input.request.turn_type === 'tool_result' || input.request.turn_type === 'subagent' ? 0 : 0.5;
  const heavy = countMatches(input.request.prompt_text, HEAVY);
  const light = countMatches(input.request.prompt_text, LIGHT);
  const heuristic = clamp(0.5 + 0.15 * (heavy - light));
  const pinnedCost = estimateWeightedCostUsd(input.pinnedModel, tokens, outputTokens);
  const candidateCost = candidate ? estimateWeightedCostUsd(candidate, tokens, outputTokens) : 0;
  const cost = candidate ? clamp(0.5 + 0.5 * ((pinnedCost - candidateCost) / Math.max(pinnedCost, 1e-9))) : 0.5;
  const gap = capabilityGap(direction, input.pinnedModel, candidate);
  const cap = Math.max(pressure, heuristic, turn) >= 0.65 ? directionSignal(direction, gap) : 0.5;
  const directionCost = direction === 'upgrade' ? cost : 1 - cost;
  const score = clamp(0.35 * pressure + 0.2 * turn + 0.2 * heuristic + 0.15 * cap + 0.1 * directionCost);
  const agrees = [pressure, turn, heuristic, cap, directionCost].filter((value) =>
    (value > 0.5) === (direction === 'upgrade'),
  ).length;
  const confidence = 0.6 * (agrees / 5) + 0.4 * clamp(tokens / 25_000);
  const threshold = direction === 'upgrade' ? config.upgrade_score_threshold : config.downgrade_score_threshold;
  const meets = direction === 'upgrade' ? score >= threshold : score <= threshold;
  const selected = candidate !== null && meets && confidence >= config.confidence_threshold;
  const reasons: string[] = [];
  if (pressure >= 0.65) reasons.push('context_pressure');
  if (heuristic >= 0.65) reasons.push('heavy_heuristics');
  if (turn >= 0.75) reasons.push('planning_turn');
  if (cap >= 0.65) reasons.push('capability_support');
  if (candidate === null) reasons.push('no_suitable_candidate');
  reasons.push(selected ? `${direction}_threshold_met` : 'threshold_not_met');
  return {
    score, confidence, targetTier: selected ? targetTier : null,
    direction: direction, candidate_model_id: candidate?.id ?? null,
    estimated_output_tokens: outputTokens,
    estimated_cost_pinned_usd: pinnedCost,
    estimated_cost_candidate_usd: candidateCost,
    capability_gap: gap, reasons,
  };
}
