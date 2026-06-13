import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXPECTED } from './.engine-build/data/expected-findings.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data', 'batches');
const load = (id) => JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8'));

const LIFECYCLE = new Set(['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer']);
const STAGES = new Set([
  'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled',
  'decisionmakerboughtin', 'contractsent', 'closedwon', 'closedlost',
]);

for (const batchId of Object.keys(EXPECTED)) {
  const key = EXPECTED[batchId];

  test(`${batchId}: parses and conforms to the record contract`, () => {
    const b = load(batchId);
    assert.equal(b.id, batchId);
    assert.equal(b.tier, key.tier);
    assert.ok(b.companies.length && b.contacts.length && b.deals.length, 'has records of every type');

    const companyIds = new Set(b.companies.map((c) => c.id));
    for (const c of b.companies) {
      assert.ok(c.id && c.name && c.domain, `company ${c.id} has id/name/domain`);
    }
    for (const ct of b.contacts) {
      assert.ok(ct.email.includes('@'), `contact ${ct.id} has an email`);
      assert.ok(LIFECYCLE.has(ct.lifecycleStage), `contact ${ct.id} lifecycleStage valid`);
      assert.ok(companyIds.has(ct.companyId), `contact ${ct.id} points at a real company`);
    }
    for (const d of b.deals) {
      assert.ok(STAGES.has(d.stage), `deal ${d.id} stage valid`);
      assert.ok(companyIds.has(d.companyId), `deal ${d.id} points at a real company`);
      assert.equal(typeof d.amount, 'number', `deal ${d.id} amount is numeric`);
    }
  });

  test(`${batchId}: every planted issue references records that exist`, () => {
    const b = load(batchId);
    const ids = new Set([
      ...b.companies.map((c) => c.id),
      ...b.contacts.map((c) => c.id),
      ...b.deals.map((d) => d.id),
    ]);
    for (const issue of key.issues) {
      for (const rid of issue.recordIds) {
        assert.ok(ids.has(rid), `${batchId} planted issue references missing record ${rid}`);
      }
    }
  });

  test(`${batchId}: covers the expected specialist categories`, () => {
    const cats = new Set(key.issues.map((i) => i.category));
    // Trivial deliberately exercises only a subset; lite/full must span more domains.
    const expectedMin = { trivial: 2, lite: 3, full: 4 }[batchId];
    assert.ok(cats.size >= expectedMin, `${batchId} spans ≥${expectedMin} categories (got ${cats.size})`);
  });
}
