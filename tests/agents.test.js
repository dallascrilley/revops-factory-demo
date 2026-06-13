import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fixtureTransport,
  parseFindings,
  sharedContext,
  ANTI_SPEC,
} from './.engine-build/agents/client.js';
import { selectSpecialists, ALL_SPECIALISTS } from './.engine-build/agents/index.js';
import { buildCoordinatorCall, parseCoordinator } from './.engine-build/agents/coordinator.js';
import { classifyRisk, fuseFindings } from './.engine-build/components/engine.js';
import { stageLogic } from './.engine-build/agents/stage-logic.js';
import { enrichment } from './.engine-build/agents/enrichment.js';
import { dedup } from './.engine-build/agents/dedup.js';
import { attribution } from './.engine-build/agents/attribution.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const lite = load('../src/data/batches/lite.json');
const fixtures = load('./fixtures/lite.json');

// ── Partitioning: each specialist reads ONLY its slice ───────────────────────

test('slice partitioning sends each specialist only the records it needs', () => {
  assert.deepEqual(Object.keys(stageLogic.slice(lite)), ['deals']);
  assert.deepEqual(Object.keys(enrichment.slice(lite)), ['companies']);
  assert.deepEqual(Object.keys(attribution.slice(lite)).sort(), ['contacts', 'deals']);
  assert.deepEqual(Object.keys(dedup.slice(lite)).sort(), ['companies', 'contacts', 'deals']);

  // The stage-logic slice must not leak attribution/email fields.
  const dealFields = Object.keys(stageLogic.slice(lite).deals[0]);
  assert.ok(!dealFields.includes('attribution'), 'stage-logic slice omits attribution');
});

// ── Tier selection matches the risk classifier ──────────────────────────────

test('selectSpecialists count matches classifyRisk for every tier', () => {
  for (const id of ['trivial', 'lite', 'full']) {
    const batch = load(`../src/data/batches/${id}.json`);
    const profile = classifyRisk(batch);
    assert.equal(selectSpecialists(profile.tier).length, profile.specialistCount, `${id}`);
  }
  assert.equal(ALL_SPECIALISTS.length, 4);
});

// ── Anti-spec is injected everywhere ─────────────────────────────────────────

test('every specialist system prompt and the coordinator include the anti-spec', () => {
  const shared = sharedContext(lite);
  for (const s of ALL_SPECIALISTS) {
    assert.ok(s.buildCall(lite, shared).system.includes(ANTI_SPEC), `${s.category} has anti-spec`);
  }
  const coord = buildCoordinatorCall([], 'approve', shared, 'm');
  assert.ok(coord.system.includes(ANTI_SPEC), 'coordinator has anti-spec');
});

// ── Fixture transport replays without network; full fixture run fuses correctly ─

test('fixtureTransport replays recorded responses by label', async () => {
  const transport = fixtureTransport(fixtures);
  const raw = await transport({ label: 'dedup', model: 'm', system: '', user: '' });
  assert.equal(raw.usage.inputTokens, 900);
  const findings = parseFindings(raw.text);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].category, 'dedup');
});

test('fixtureTransport throws on a missing label (stale fixtures fail loud)', async () => {
  const transport = fixtureTransport(fixtures);
  await assert.rejects(() => transport({ label: 'ghost', model: 'm', system: '', user: '' }));
});

test('end-to-end fixture run for lite fuses to requested_changes (a critical present)', async () => {
  const transport = fixtureTransport(fixtures);
  const { tier } = classifyRisk(lite);
  const shared = sharedContext(lite);
  const specialists = selectSpecialists(tier);
  const outputs = [];
  for (const s of specialists) {
    const raw = await transport(s.buildCall(lite, shared));
    outputs.push(parseFindings(raw.text));
  }
  const fusion = fuseFindings(outputs);
  assert.equal(fusion.verdict, 'requested_changes'); // dl_105 negative amount is critical
  assert.ok(fusion.findings.length >= 4);

  const coordRaw = await transport(buildCoordinatorCall(fusion.findings, fusion.verdict, shared, 'm'));
  const coord = parseCoordinator(coordRaw.text);
  assert.ok(coord.summary.length > 0);
  assert.deepEqual(coord.suppressRecordIds, []);
});
