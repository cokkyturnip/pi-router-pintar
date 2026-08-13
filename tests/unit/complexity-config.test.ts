import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPERATOR_CONFIG,
  resolveComplexityScorerConfigFromEnv,
} from '../../src/config/defaults.js';
import {
  ComplexityScorerConfigSchema,
  PinReasonSchema,
} from '../../src/domain/types/schemas.js';

describe('Plan B complexity configuration', () => {
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

  it('accepts complexity pin reasons', () => {
    expect(PinReasonSchema.parse('complexity_upgrade')).toBe('complexity_upgrade');
    expect(PinReasonSchema.parse('complexity_downgrade')).toBe('complexity_downgrade');
  });

  it('keeps complexity configuration in the operator defaults', () => {
    expect(DEFAULT_OPERATOR_CONFIG.complexity_scorer).toMatchObject({
      output_to_input_ratio: 0.05,
      min_lightweight_streak: 3,
    });
  });

  it('applies valid environment overrides and ignores invalid values', () => {
    const resolved = resolveComplexityScorerConfigFromEnv(
      DEFAULT_OPERATOR_CONFIG.complexity_scorer,
      {
        SMART_ROUTER_COMPLEXITY_OUTPUT_RATIO: '0.01',
        SMART_ROUTER_COMPLEXITY_MIN_STREAK: '4',
        SMART_ROUTER_COMPLEXITY_CONFIDENCE_THRESHOLD: 'not-a-number',
        SMART_ROUTER_COMPLEXITY_MIN_DWELL_MS: '-1',
      },
    );

    expect(resolved.output_to_input_ratio).toBe(0.01);
    expect(resolved.min_lightweight_streak).toBe(4);
    expect(resolved.confidence_threshold).toBe(0.6);
    expect(resolved.min_dwell_ms).toBe(300_000);
  });
});
