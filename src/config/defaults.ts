/**
 * Operator configuration defaults (FR-021).
 * Values sourced from specs/001-build-smart-router/data-model.md § Configuration (Operator).
 */

import {
  DEFAULT_COMPLEXITY_SCORER_CONFIG,
  DEFAULT_DEGRADED_ROUTE_CONFIG,
  DEFAULT_LOCAL_ZERO_CONFIG,
  DEFAULT_PLANNING_DELEGATE_CONFIG,
  DEFAULT_SAAR_CONFIG,
  DEFAULT_SPECULATIVE_PREWARM_CONFIG,
  DEFAULT_WORKLOAD_HEAT_CONFIG,
  resolvePlanningDelegateConfigFromEnv,
  resolveSaarConfigFromEnv,
  type ComplexityScorerConfig,
  type OperatorConfig,
  ComplexityScorerConfigSchema,
} from '../domain/types/schemas.js';
import { DEFAULT_LOW_INTENSITY_WEIGHTS } from '../domain/routing/tier-features.js';

export {
  DEFAULT_COMPLEXITY_SCORER_CONFIG,
  DEFAULT_LOCAL_ZERO_CONFIG,
  DEFAULT_PLANNING_DELEGATE_CONFIG,
  DEFAULT_SAAR_CONFIG,
  DEFAULT_SPECULATIVE_PREWARM_CONFIG,
  DEFAULT_WORKLOAD_HEAT_CONFIG,
  resolvePlanningDelegateConfigFromEnv,
  resolveSaarConfigFromEnv,
} from '../domain/types/schemas.js';

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
    output_to_input_ratio: numberOverride(
      'SMART_ROUTER_COMPLEXITY_OUTPUT_RATIO',
      base.output_to_input_ratio,
      0,
      0.05,
    ),
    upgrade_score_threshold: numberOverride(
      'SMART_ROUTER_COMPLEXITY_UPGRADE_THRESHOLD',
      base.upgrade_score_threshold,
      0,
      1,
    ),
    downgrade_score_threshold: numberOverride(
      'SMART_ROUTER_COMPLEXITY_DOWNGRADE_THRESHOLD',
      base.downgrade_score_threshold,
      0,
      1,
    ),
    confidence_threshold: numberOverride(
      'SMART_ROUTER_COMPLEXITY_CONFIDENCE_THRESHOLD',
      base.confidence_threshold,
      0,
      1,
    ),
    min_lightweight_streak: numberOverride(
      'SMART_ROUTER_COMPLEXITY_MIN_STREAK',
      base.min_lightweight_streak,
      1,
      10,
      true,
    ),
    min_dwell_ms: numberOverride(
      'SMART_ROUTER_COMPLEXITY_MIN_DWELL_MS',
      base.min_dwell_ms,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    capability_override_gap: numberOverride(
      'SMART_ROUTER_COMPLEXITY_CAPABILITY_GAP',
      base.capability_override_gap,
      0,
      1,
    ),
  });
}

/** Merge operator env overrides onto defaults. */
export function resolveOperatorConfigFromEnv(
  base: OperatorConfig = DEFAULT_OPERATOR_CONFIG,
): OperatorConfig {
  return {
    ...base,
    saar: resolveSaarConfigFromEnv(base.saar),
    planning_delegate: resolvePlanningDelegateConfigFromEnv(base.planning_delegate),
    complexity_scorer: resolveComplexityScorerConfigFromEnv(base.complexity_scorer),
  };
}

export const DEFAULT_OPERATOR_CONFIG: Readonly<OperatorConfig> = {
  frugality: {
    lambda_cost: 0.5,
    lambda_latency: 0.1,
    lambda_verbosity: 0.15,
  },
  loop_escalation: {
    threshold: 3,
  },
  pricing: {
    staleness_days: 14,
  },
  local: {
    min_memory_gb_full: 16,
    min_memory_gb_classification: 8,
    battery_threshold_pct: 20,
  },
  hydra: {
    artifact_cache_path: '.pi-smart-router/models/',
    encoder: 'minilm',
    hydra_heads: 'learned_projection',
  },
  low_intensity: {
    weights: DEFAULT_LOW_INTENSITY_WEIGHTS,
    high_threshold: 0.65,
    low_threshold: 0.35,
    p_success_alpha: 0.5,
  },
  saar: DEFAULT_SAAR_CONFIG,
  planning_delegate: DEFAULT_PLANNING_DELEGATE_CONFIG,
  complexity_scorer: DEFAULT_COMPLEXITY_SCORER_CONFIG,
  local_zero: DEFAULT_LOCAL_ZERO_CONFIG,
  degraded_route: DEFAULT_DEGRADED_ROUTE_CONFIG,
  /** Heat knobs only (SP-215) — no frugality default or absolute-gate flips. */
  workload_heat: DEFAULT_WORKLOAD_HEAT_CONFIG,
  /** Speculative prewarm (SP-217, #117): default OFF; opt-in via operator config. */
  speculative_prewarm: DEFAULT_SPECULATIVE_PREWARM_CONFIG,
  pin_only_fallback: false,
} as const;
