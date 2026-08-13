import { describe, expect, it } from 'vitest';

import type { ModelProfile, RoutingRequest } from '../../src/domain/types/index.js';
import {
  mapPiModelToProfile,
  type PiModelInput,
} from '../../src/config/pi-model-mapper.js';
import { applyCatalogPricesToFleet } from '../../src/infrastructure/pricing/price-broker.js';
import { SessionPinner } from '../../src/domain/pinning/session-pinner.js';
import { MemoryStore } from '../../src/infrastructure/persistence/memory-store.js';

/**
 * Realistic registry inputs (Task 1): component prices per token, Pi
 * contextWindow/maxTokens. The catalog supplies the free/paid per-1M rates.
 */
const REGISTRY: readonly PiModelInput[] = [
  {
    provider: 'openai',
    id: 'hy3-free',
    name: 'Hy3 Free',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    cost: {
      input: 0.6 / 1_000_000,
      output: 1.2 / 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
];

function buildFleet(): ModelProfile[] {
  const mapped = REGISTRY.map((entry) => mapPiModelToProfile(entry));
  return applyCatalogPricesToFleet(mapped, {
    registry_snapshot: { 'openai/hy3-free': 0, 'openai/gpt-5.6-luna': 0.9 },
    user_overrides: {},
    last_updated: '2026-08-13T00:00:00.000Z',
    source: 'registry',
  });
}

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    request_id: 'req-1',
    session_id: 's1',
    prompt_text: 'ok, cukup',
    ...overrides,
  };
}

const HEAVY_PROMPT = [
  'Refactor the distributed architecture and plan the migration to event sourcing.',
  'Debug the race condition in the error handler and write regression tests.',
  '```ts',
  'export async function migrate(schema: Schema) {',
  '  await db.transaction(async (tx) => {',
  '    for (const table of schema.tables) await tx.alter(table);',
  '  });',
  '}',
  '```',
  'Also audit the test suite for flaky error assertions before merging.',
].join('\n');

describe('complexity switching session sequences', () => {
  it('Scenario A: overflow and compaction hard breaks still reset the pin', () => {
    const fleet = buildFleet();
    const econ = fleet.find((m) => m.id === 'hy3-free')!;
    const frontier = fleet.find((m) => m.id === 'gpt-5.6-luna')!;
    expect(econ.limits?.max_input_tokens).toBe(128_000);
    expect(frontier.limits?.max_input_tokens).toBe(1_000_000);
    expect(econ.pricing.fallback_cost_per_1m).toBe(0);
    expect(frontier.pricing.input_rate_per_1m).toBeCloseTo(0.6);

    const pinner = new SessionPinner();
    pinner.recordPin('s1', econ.id, 'initial');

    // 1. Input beyond the economical model's effective window → context overflow.
    const overflow = pinner.lookupPin(
      request({ prompt_text: HEAVY_PROMPT, estimated_input_tokens: 200_000 }),
      fleet,
    );
    expect(overflow.action).toBe('break');
    expect(overflow.breakReason).toBe('context_overflow');
    expect(pinner.getPin('s1')).toBeNull();

    // 2. Route selects the frontier model and pins it.
    pinner.recordPin('s1', frontier.id, 'initial');

    // 3. Compaction always breaks the pin regardless of model.
    const compacted = pinner.lookupPin(
      request({ prompt_text: HEAVY_PROMPT, estimated_input_tokens: 10_000, compaction_flag: true }),
      fleet,
    );
    expect(compacted.action).toBe('break');
    expect(compacted.breakReason).toBe('compaction');
    expect(pinner.getPin('s1')).toBeNull();

    // 4. Next route is free to create a fresh economical pin.
    const next = pinner.lookupPin(request({ estimated_input_tokens: 500 }), fleet);
    expect(next.action).toBe('no_pin');
  });

  it('Scenario B: upgrade, hysteresis, dwell-gated downgrade, ambiguous hold', async () => {
    const fleet = buildFleet();
    const econ = fleet.find((m) => m.id === 'hy3-free')!;
    let now = Date.now();

    const store = new MemoryStore([]);
    const pinner = new SessionPinner({ store, complexityClock: () => now });
    pinner.recordPin('s1', econ.id, 'initial');

    // 1. One high-confidence heavy request upgrades to frontier.
    const heavy = pinner.lookupPin(
      request({ prompt_text: HEAVY_PROMPT, estimated_input_tokens: 100_000 }),
      fleet,
    );
    expect(heavy.action).toBe('use_pin');
    expect(heavy.pinnedModel?.id).toBe('gpt-5.6-luna');
    expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_upgrade');

    // 2. Two light turns keep the frontier pin (streak 1, 2).
    const light = (): ReturnType<SessionPinner['lookupPin']> =>
      pinner.lookupPin(request({ estimated_input_tokens: 10 }), fleet);
    expect(light().pinnedModel?.id).toBe('gpt-5.6-luna');
    expect(light().pinnedModel?.id).toBe('gpt-5.6-luna');

    // 3. Past the five-minute dwell, the third light turn downgrades.
    now += 300_001;
    const downgrade = light();
    expect(downgrade.pinnedModel?.id).toBe('hy3-free');
    expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_downgrade');

    // 4. The persisted pin reason round-trips through the store.
    const restoredPinner = new SessionPinner({ store });
    await restoredPinner.restoreSessionPin('s1');
    expect(restoredPinner.getPin('s1')?.pin_reason).toBe('complexity_downgrade');
    expect(restoredPinner.getPin('s1')?.pinned_model_id).toBe('hy3-free');

    // 5. An ambiguous short planning keyword is low-confidence → pin unchanged.
    const ambiguous = pinner.lookupPin(
      request({ prompt_text: 'plan besok mau apa', estimated_input_tokens: 32, turn_type: 'planning' }),
      fleet,
    );
    expect(ambiguous.pinnedModel?.id).toBe('hy3-free');
    expect(pinner.getPin('s1')?.pin_reason).toBe('complexity_downgrade');
  });
});
