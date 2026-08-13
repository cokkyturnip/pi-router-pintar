import { describe, expect, it } from 'vitest';
import type { ModelProfile, RoutingRequest } from '../../src/domain/types/index.js';
import {
  estimateOutputTokens,
  estimateWeightedCostUsd,
  scoreComplexity,
} from '../../src/domain/routing/complexity-scorer.js';

const econPin: ModelProfile = {
  id: 'hy3-free',
  provider: 'opencode',
  tier: 'economical-cloud',
  capabilities: { reasoning: 0.55, code_gen: 0.6, tool_use: 0.7 },
  pricing: { fallback_cost_per_1m: 0 },
  limits: { max_input_tokens: 128_000, max_output_tokens: 16_384 },
};

const hy3: ModelProfile = {
  id: 'hy3',
  provider: 'opencode',
  tier: 'economical-cloud',
  capabilities: { reasoning: 0.7, code_gen: 0.75, tool_use: 0.85 },
  pricing: {
    fallback_cost_per_1m: 0.3,
    input_rate_per_1m: 0.12,
    output_rate_per_1m: 0.53,
  },
  limits: { max_input_tokens: 256_000, max_output_tokens: 32_768 },
};

const frontierPin: ModelProfile = {
  id: 'gpt-5.6-luna',
  provider: 'openai',
  tier: 'frontier-cloud',
  capabilities: { reasoning: 0.85, code_gen: 0.95, tool_use: 0.9 },
  pricing: {
    fallback_cost_per_1m: 0.35,
    input_rate_per_1m: 0.1,
    output_rate_per_1m: 0.6,
  },
  limits: { max_input_tokens: 1_000_000, max_output_tokens: 16_384 },
};

const fleet = [econPin, hy3, frontierPin];

function makeRequest(
  promptText: string,
  estimatedInputTokens: number,
  turnType: RoutingRequest['turn_type'] = 'main_loop',
): RoutingRequest {
  return {
    request_id: 'request-1',
    session_id: 'session-1',
    prompt_text: promptText,
    turn_type: turnType,
    estimated_input_tokens: estimatedInputTokens,
  };
}

const heavyArchitecturePrompt = [
  'Refactor the distributed checkout architecture before the migration window.',
  'Debug the race condition in the event-driven queue and reproduce the error in tests.',
  'Plan the database schema migration, index strategy, timeout handling, and stack trace analysis.',
  '```ts',
  'export async function migrate() { /* implementation */ }',
  '```',
].join('\n');

describe('complexity scorer', () => {
  it('uses a five-percent output estimate without a cost floor', () => {
    expect(estimateOutputTokens(100_000, { output_to_input_ratio: 0.05 })).toBe(5_000);
    expect(estimateOutputTokens(100_000, { output_to_input_ratio: 0.5 })).toBe(5_000);
    expect(estimateOutputTokens(1, { output_to_input_ratio: 0.05 })).toBe(1);
    expect(estimateOutputTokens(0, { output_to_input_ratio: 0.05 })).toBe(0);
  });

  it('uses weighted input/output pricing rather than the arithmetic mean', () => {
    expect(estimateWeightedCostUsd(frontierPin, 100_000, 5_000)).toBeCloseTo(0.013, 6);
    expect(estimateWeightedCostUsd(hy3, 100_000, 5_000)).toBeCloseTo(0.01465, 6);
  });

  it('keeps a short summary request below the frontier upgrade threshold', () => {
    const result = scoreComplexity({
      request: makeRequest('buat ringkasan dari link youtube', 500),
      pinnedModel: econPin,
      fleet,
    });

    expect(result.score).toBeLessThan(0.7);
    expect(result.targetTier).toBeNull();
  });

  it('recognizes a long architecture/refactor request as frontier-worthy', () => {
    const result = scoreComplexity({
      request: makeRequest(heavyArchitecturePrompt, 150_000),
      pinnedModel: econPin,
      fleet,
    });

    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.targetTier).toBe('frontier-cloud');
    expect(result.direction).toBe('upgrade');
    expect(result.candidate_model_id).toBe('gpt-5.6-luna');
  });

  it('does not upgrade a short planning keyword with low confidence', () => {
    const result = scoreComplexity({
      request: makeRequest('plan besok mau apa', 32, 'planning'),
      pinnedModel: econPin,
      fleet,
    });

    expect(result.confidence).toBeLessThan(0.6);
    expect(result.targetTier).toBeNull();
  });

  it('returns a downgrade suggestion for a light request on a frontier pin', () => {
    const result = scoreComplexity({
      request: makeRequest('ok, cukup', 1_000),
      pinnedModel: frontierPin,
      fleet,
    });

    expect(result.targetTier).toBe('economical-cloud');
    expect(result.direction).toBe('downgrade');
    expect(result.candidate_model_id).toBe('hy3-free');
  });

  it('uses prompt length when estimated input tokens are absent', () => {
    const request = makeRequest('ok, cukup', 1_000);
    const { estimated_input_tokens, ...requestWithoutEstimate } = request;
    void estimated_input_tokens;
    const result = scoreComplexity({
      request: requestWithoutEstimate,
      pinnedModel: frontierPin,
      fleet,
    });

    expect(result.estimated_output_tokens).toBe(1);
  });

  it('keeps unhealthy and context-incompatible candidates out of selection', () => {
    const unavailableFrontier: ModelProfile = {
      ...frontierPin,
      id: 'unavailable-frontier',
      healthy: false,
    };
    const narrowFrontier: ModelProfile = {
      ...frontierPin,
      id: 'narrow-frontier',
      limits: { max_input_tokens: 10_000, max_output_tokens: 16_384 },
    };
    const result = scoreComplexity({
      request: makeRequest(heavyArchitecturePrompt, 150_000),
      pinnedModel: econPin,
      fleet: [econPin, unavailableFrontier, narrowFrontier],
    });

    expect(result.candidate_model_id).toBeNull();
    expect(result.reasons).toContain('no_suitable_candidate');
  });
});
