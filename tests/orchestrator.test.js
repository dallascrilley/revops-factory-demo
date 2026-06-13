import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runReview } from './.engine-build/components/orchestrator.js';
import { fixtureTransport } from './.engine-build/agents/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const lite = load('../src/data/batches/lite.json');
const fixtures = load('./fixtures/lite.json');

async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

test('runReview emits the full trace in order and ends with a verdict', async () => {
  const events = await collect(runReview(lite, { transport: fixtureTransport(fixtures) }));
  assert.equal(events[0].type, 'classified');
  assert.equal(events[0].tier, 'lite');
  assert.equal(events[0].specialistCount, 3);

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'agent_start').length, 3);
  assert.equal(types.filter((t) => t === 'agent_done').length, 3);
  assert.ok(types.includes('fused'));
  assert.ok(types.includes('coordinator_done'));

  const last = events.at(-1);
  assert.equal(last.type, 'verdict');
  assert.equal(last.result.verdict, 'requested_changes'); // dl_105 negative amount is critical
  assert.ok(last.result.findings.length >= 4);

  const cost = events.find((e) => e.type === 'cost');
  assert.ok(cost.usd > 0 && cost.tokens > 0);
});

test('break glass forces approval but keeps the findings visible', async () => {
  const events = await collect(runReview(lite, { transport: fixtureTransport(fixtures), breakGlass: true }));
  const result = events.at(-1).result;
  assert.equal(result.verdict, 'approve');
  assert.equal(result.breakGlass, true);
  assert.ok(result.findings.length >= 4, 'findings still surfaced');
});

test('a failing model call fails back to the previous-gen model and continues', async () => {
  // First call per label throws; the resilience retry (fallback model) succeeds.
  const calls = {};
  const base = fixtureTransport(fixtures);
  const flaky = async (call) => {
    calls[call.label] = (calls[call.label] || 0) + 1;
    if (calls[call.label] === 1) throw new Error('rate limited');
    return base(call);
  };
  const events = await collect(runReview(lite, { transport: flaky }));
  const done = events.filter((e) => e.type === 'agent_done');
  assert.ok(done.length === 3 && done.every((e) => e.failedBack === true), 'all specialists failed back');
  assert.equal(events.at(-1).result.verdict, 'requested_changes');
});

test('a specialist that fully fails is dropped to degraded, run still completes', async () => {
  const base = fixtureTransport(fixtures);
  const brokenDedup = async (call) => {
    if (call.label === 'dedup') throw new Error('down'); // throws on both primary + fallback
    return base(call);
  };
  const events = await collect(runReview(lite, { transport: brokenDedup }));
  assert.ok(events.some((e) => e.type === 'agent_error' && e.label === 'dedup'));
  assert.equal(events.at(-1).type, 'verdict'); // run completed despite the failure
});

// ── Node HTTP harness E2E (NOT wrangler pages dev — see docs/solutions) ──────

test('HTTP harness streams valid NDJSON ending in a verdict', async () => {
  const server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for await (const e of runReview(lite, { transport: fixtureTransport(fixtures) })) {
      res.write(JSON.stringify(e) + '\n');
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/review`, { method: 'POST' });
    const text = await resp.text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l)); // every line is valid JSON
    assert.equal(lines[0].type, 'classified');
    assert.equal(lines.at(-1).type, 'verdict');
    assert.equal(lines.at(-1).result.verdict, 'requested_changes');
  } finally {
    server.close();
  }
});
