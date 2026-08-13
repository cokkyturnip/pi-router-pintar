import { describe, expect, it } from 'vitest';
import { SessionPinner } from '../../src/domain/pinning/session-pinner.js';
import type { ModelProfile, RoutingRequest } from '../../src/domain/types/index.js';

function model(overrides: Partial<ModelProfile> & { id: string; tier: ModelProfile['tier'] }): ModelProfile {
  return {
    provider: 'openai',
    capabilities: { reasoning: 0.5, code_gen: 0.5, tool_use: 0.5 },
    pricing: { fallback_cost_per_1m: 1 },
    limits: { max_input_tokens: 128_000, max_output_tokens: 16_384 },
    ...overrides,
  };
}

const econ = model({
  id: 'hy3-paid', tier: 'economical-cloud',
  capabilities: { reasoning: 0.55, code_gen: 0.65, tool_use: 0.7 },
  pricing: { fallback_cost_per_1m: 0.12 },
});
const frontier = model({
  id: 'gpt-5.6-luna', tier: 'frontier-cloud',
  capabilities: { reasoning: 0.9, code_gen: 0.95, tool_use: 0.9 },
  pricing: { fallback_cost_per_1m: 2.0 },
  limits: { max_input_tokens: 1_000_000, max_output_tokens: 32_768 },
});
const fleet = [econ, frontier];

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    request_id: 'req-1', session_id: 's1', prompt_text: 'ok',
    estimated_input_tokens: 1_000, ...overrides,
  };
}

const heavyPrompt = [
  'Refactor the architecture and migration plan.',
  'Debug the distributed error and write tests for the race condition.',
  '```ts export async function migrate() {} ```',
].join('\n');

function light(pinner: SessionPinner): ReturnType<SessionPinner['lookupPin']> {
  return pinner.lookupPin(request({ prompt_text: 'ok, cukup' }), fleet);
}

describe('SessionPinner complexity switching', () => {
  it('upgrades an economical pin for one justified heavy request', () => {
    const pinner = new SessionPinner();
    pinner.recordPin('s1', econ.id, 'initial');

    const result = pinner.lookupPin(request({
      prompt_text: heavyPrompt, estimated_input_tokens: 100_000,
    }), fleet);

    expect(result.action).toBe('use_pin');
    expect(result.pinnedModel?.tier).toBe('frontier-cloud');
    expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_upgrade');
  });

  it('requires three light turns and minimum dwell before downgrade', () => {
    let now = Date.now();
    const pinner = new SessionPinner({ complexityClock: () => now });
    pinner.recordPin('s1', frontier.id, 'initial');

    expect(light(pinner).pinnedModel?.id).toBe(frontier.id);
    expect(light(pinner).pinnedModel?.id).toBe(frontier.id);
    expect(light(pinner).pinnedModel?.id).toBe(frontier.id);

    now += 300_001;
    const result = light(pinner);

    expect(result.pinnedModel?.tier).toBe('economical-cloud');
    expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_downgrade');
  });

  it('holds on ambiguous scores and resets the light streak on a pin change', () => {
    const pinner = new SessionPinner();
    pinner.recordPin('s1', frontier.id, 'initial');

    const result = pinner.lookupPin(request({
      prompt_text: 'plan besok mau apa', estimated_input_tokens: 32, turn_type: 'planning',
    }), fleet);

    expect(result.pinnedModel?.id).toBe(frontier.id);
    expect(pinner.getPin('s1')?.pin_reason).toBe('initial');
  });

  it('never persistently switches on a tool result', () => {
    const pinner = new SessionPinner();
    pinner.recordPin('s1', frontier.id, 'initial');

    const result = pinner.lookupPin(request({
      prompt_text: heavyPrompt, estimated_input_tokens: 10, turn_type: 'tool_result',
    }), fleet);

    expect(['sub_route', 'use_pin']).toContain(result.action);
    expect(pinner.getPin('s1')?.pinned_model_id).toBe(frontier.id);
  });

  it('keeps compaction ahead of complexity scoring', () => {
    const pinner = new SessionPinner();
    pinner.recordPin('s1', econ.id, 'initial');

    const result = pinner.lookupPin(request({
      prompt_text: heavyPrompt, estimated_input_tokens: 10_000, compaction_flag: true,
    }), fleet);

    expect(result.action).toBe('break');
    expect(result.breakReason).toBe('compaction');
    expect(pinner.getPin('s1')).toBeNull();
  });
});
