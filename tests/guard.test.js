import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideServe, commitFreshRun } from './.engine-build/components/guard.js';

function memKV() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
  };
}

const result = (over = {}) => ({
  batchId: 'lite',
  tier: 'lite',
  specialistCount: 3,
  coordinatorModel: 'google/gemini-2.5-flash',
  findings: [],
  verdict: 'approved_with_comments',
  summary: 'ok',
  breakGlass: false,
  cost: { tokens: 1000, usd: 0.05 },
  ...over,
});

const cfg = (over = {}) => ({
  dailyTokenCap: 5_000_000,
  ratePerWindow: 10,
  windowSec: 3600,
  today: '2026-06-13',
  ...over,
});

test('cold run is fresh; an identical re-run is served from cache', async () => {
  const kv = memKV();
  const first = await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg());
  assert.equal(first.mode, 'fresh');

  await commitFreshRun(kv, 'run:lite:abc', result(), cfg());

  const second = await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg());
  assert.equal(second.mode, 'cached');
  assert.equal(second.cached.cost.tokens, 1000);
});

test('over budget with a prior run fails back to the last good run', async () => {
  const kv = memKV();
  await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg());
  await commitFreshRun(kv, 'run:lite:abc', result(), cfg());

  // A different batch key (cache miss) under a now-tiny budget cap.
  const d = await decideServe(kv, 'run:full:xyz', '2.2.2.2', cfg({ dailyTokenCap: 1 }));
  assert.equal(d.mode, 'failback');
  assert.equal(d.reason, 'daily token budget reached');
  assert.equal(d.cached.batchId, 'lite');
});

test('over budget with no cached run yields an error', async () => {
  const kv = memKV();
  const d = await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg({ dailyTokenCap: 0 }));
  assert.equal(d.mode, 'error');
  assert.match(d.reason, /no cached run/);
});

test('rate limit trips after ratePerWindow fresh decisions for an IP', async () => {
  const kv = memKV();
  // Seed a last-good run so the trip fails back rather than errors.
  await commitFreshRun(kv, 'run:seed', result(), cfg());

  const c = cfg({ ratePerWindow: 2 });
  await decideServe(kv, 'run:a', '9.9.9.9', c); // rate 1 → fresh
  await decideServe(kv, 'run:b', '9.9.9.9', c); // rate 2 → fresh
  const tripped = await decideServe(kv, 'run:c', '9.9.9.9', c); // rate 3 → over
  assert.equal(tripped.mode, 'failback');
  assert.equal(tripped.reason, 'rate limit reached');
});

test('cacheHitRate reflects hits over total decisions', async () => {
  const kv = memKV();
  await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg()); // miss, total=1
  await commitFreshRun(kv, 'run:lite:abc', result(), cfg());
  const hit = await decideServe(kv, 'run:lite:abc', '1.1.1.1', cfg()); // hit, total=2
  assert.equal(hit.mode, 'cached');
  assert.equal(hit.cacheHitRate, 0.5); // 1 hit / 2 total
});
