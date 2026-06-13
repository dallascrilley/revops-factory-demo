import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyRisk,
  fuseFindings,
  costOf,
  cacheKey,
  MODELS,
} from './.engine-build/components/engine.js';
import { EXPECTED } from './.engine-build/data/expected-findings.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data', 'batches');
const load = (id) => JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8'));

const finding = (over = {}) => ({
  severity: 'warning',
  category: 'dedup',
  recordType: 'company',
  recordId: 'co_x',
  claim: 'duplicate company',
  evidence: 'same domain',
  ...over,
});

// ── classifyRisk ─────────────────────────────────────────────────────────────

test('classifyRisk: each batch lands in its expected tier and team size', () => {
  for (const id of Object.keys(EXPECTED)) {
    const profile = classifyRisk(load(id));
    assert.equal(profile.tier, EXPECTED[id].tier, `${id} tier`);
    assert.equal(profile.specialistCount, EXPECTED[id].specialistCount, `${id} team size`);
  }
});

test('classifyRisk: trivial downgrades the coordinator, lite/full keep the top model', () => {
  assert.equal(classifyRisk(load('trivial')).coordinatorModel, MODELS.haiku);
  assert.equal(classifyRisk(load('lite')).coordinatorModel, MODELS.sonnet);
  assert.equal(classifyRisk(load('full')).coordinatorModel, MODELS.sonnet);
});

test('classifyRisk: tier boundaries (score = companies + contacts + deals*2)', () => {
  const mk = (companies, contacts, deals) => ({
    companies: Array.from({ length: companies }, (_, i) => ({ id: `c${i}` })),
    contacts: Array.from({ length: contacts }, (_, i) => ({ id: `t${i}` })),
    deals: Array.from({ length: deals }, (_, i) => ({ id: `d${i}` })),
  });
  assert.equal(classifyRisk(mk(4, 0, 2)).tier, 'trivial'); // score 8
  assert.equal(classifyRisk(mk(5, 0, 2)).tier, 'lite'); // score 9
  assert.equal(classifyRisk(mk(0, 0, 10)).tier, 'lite'); // score 20
  assert.equal(classifyRisk(mk(1, 0, 10)).tier, 'full'); // score 21
});

// ── fuseFindings ─────────────────────────────────────────────────────────────

test('fuseFindings: dedups same problem on same record, keeping highest severity', () => {
  const a = [finding({ severity: 'warning' })];
  const b = [finding({ severity: 'critical' })]; // same key, higher severity
  const out = fuseFindings([a, b]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'critical');
  assert.equal(out.droppedCount, 1);
});

test('fuseFindings: drops malformed findings (empty claim/evidence)', () => {
  const out = fuseFindings([[finding(), finding({ recordId: 'co_y', claim: '' })]]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.droppedCount, 1);
});

test('fuseFindings: verdict is approval-biased', () => {
  assert.equal(fuseFindings([[finding({ severity: 'suggestion' })]]).verdict, 'approve');
  assert.equal(fuseFindings([[finding({ severity: 'warning' })]]).verdict, 'approved_with_comments');
  assert.equal(fuseFindings([[finding({ severity: 'critical' })]]).verdict, 'requested_changes');
  assert.equal(fuseFindings([[]]).verdict, 'approve');
});

test('fuseFindings: sorts critical first', () => {
  const out = fuseFindings([
    [finding({ severity: 'suggestion', recordId: 's' })],
    [finding({ severity: 'critical', recordId: 'c' })],
    [finding({ severity: 'warning', recordId: 'w' })],
  ]);
  assert.deepEqual(
    out.findings.map((f) => f.severity),
    ['critical', 'warning', 'suggestion'],
  );
});

// ── costOf ───────────────────────────────────────────────────────────────────

test('costOf: sums tokens and dollars at list prices', () => {
  const out = costOf([
    { model: MODELS.haiku, inputTokens: 1_000_000, outputTokens: 0 }, // $1.00
    { model: MODELS.sonnet, inputTokens: 0, outputTokens: 1_000_000 }, // $15.00
  ]);
  assert.equal(out.tokens, 2_000_000);
  assert.equal(out.usd, 16.0);
});

test('costOf: unknown model contributes tokens but no cost', () => {
  const out = costOf([{ model: 'mystery', inputTokens: 500, outputTokens: 500 }]);
  assert.equal(out.tokens, 1000);
  assert.equal(out.usd, 0);
});

// ── cacheKey ─────────────────────────────────────────────────────────────────

test('cacheKey: stable and order-independent across the model set', () => {
  assert.equal(
    cacheKey('lite', [MODELS.haiku, MODELS.sonnet]),
    cacheKey('lite', [MODELS.sonnet, MODELS.haiku]),
  );
});

test('cacheKey: differs by batch and by model set', () => {
  assert.notEqual(cacheKey('lite', [MODELS.haiku]), cacheKey('full', [MODELS.haiku]));
  assert.notEqual(cacheKey('lite', [MODELS.haiku]), cacheKey('lite', [MODELS.sonnet]));
});
