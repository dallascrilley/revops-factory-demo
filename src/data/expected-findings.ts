/**
 * Ground-truth planted issues per batch.
 *
 * This is the answer key for the synthetic data: every problem deliberately seeded
 * into src/data/batches/*.json is recorded here, keyed by the specialist domain
 * that should catch it. It serves two purposes:
 *   1. Tests assert each batch actually contains the issues we claim (so a typo in
 *      the JSON can't silently neuter the demo).
 *   2. It documents, in one place, what a correct review looks like — useful when
 *      grading the live agents' output during development.
 *
 * `recordIds` are the records the planted issue is primarily about.
 */
import type { FindingCategory, RiskTier } from '../components/types.js';

export interface PlantedIssue {
  category: FindingCategory;
  recordIds: string[];
  note: string;
}

export interface BatchAnswerKey {
  tier: RiskTier;
  /** Expected number of specialist agents for this tier (drives the risk classifier test). */
  specialistCount: number;
  issues: PlantedIssue[];
}

export const EXPECTED: Record<string, BatchAnswerKey> = {
  trivial: {
    tier: 'trivial',
    specialistCount: 2,
    issues: [
      { category: 'enrichment', recordIds: ['co_002'], note: 'Helios enriched 2024-01-12 (stale) with null industry + employeeCount' },
      { category: 'stage-logic', recordIds: ['dl_002'], note: 'closedwon with amount 0 and null closeDate' },
    ],
  },
  lite: {
    tier: 'lite',
    specialistCount: 3,
    issues: [
      { category: 'dedup', recordIds: ['co_101', 'co_102'], note: 'duplicate company — same domain cascade.example' },
      { category: 'dedup', recordIds: ['ct_101', 'ct_102'], note: 'duplicate contact — same email lee@cascade.example' },
      { category: 'attribution', recordIds: ['dl_103'], note: 'lastTouch ct_103 belongs to co_103, deal is for co_104 (cross-company)' },
      { category: 'stage-logic', recordIds: ['dl_102'], note: 'closeDate 2026-02-01 in the past, stage still open (qualifiedtobuy)' },
      { category: 'stage-logic', recordIds: ['dl_105'], note: 'negative amount (-5000)' },
      { category: 'enrichment', recordIds: ['co_103'], note: 'Brightline enriched 2023-11-04 (stale)' },
    ],
  },
  full: {
    tier: 'full',
    specialistCount: 4,
    issues: [
      { category: 'dedup', recordIds: ['co_201', 'co_202'], note: 'duplicate company — same domain vertexrobotics.example' },
      { category: 'dedup', recordIds: ['ct_201', 'ct_202'], note: 'duplicate contact — same email rae@vertexrobotics.example' },
      { category: 'dedup', recordIds: ['ct_206', 'ct_207'], note: 'duplicate contact — same email case-insensitively (ELLIS@ vs ellis@)' },
      { category: 'dedup', recordIds: ['dl_201', 'dl_202'], note: 'duplicate deal across the duplicate companies' },
      { category: 'attribution', recordIds: ['dl_207'], note: 'lastTouch ct_209 belongs to co_207, deal is for co_206 (cross-company)' },
      { category: 'attribution', recordIds: ['dl_212'], note: 'lastTouch ct_203 belongs to co_203, deal is for co_201 (cross-company)' },
      { category: 'attribution', recordIds: ['dl_211'], note: 'contractsent deal with no attribution (both touches null)' },
      { category: 'stage-logic', recordIds: ['dl_204'], note: 'closedwon with null closeDate' },
      { category: 'stage-logic', recordIds: ['dl_205'], note: 'closedwon with amount 0' },
      { category: 'stage-logic', recordIds: ['dl_206'], note: 'closeDate 2026-01-20 past, stage still open (qualifiedtobuy)' },
      { category: 'stage-logic', recordIds: ['dl_209'], note: 'negative amount (-12000)' },
      { category: 'stage-logic', recordIds: ['dl_210'], note: 'closeDate 2026-03-10 past, stage still open (appointmentscheduled)' },
      { category: 'enrichment', recordIds: ['co_204'], note: 'Pinecrest enriched 2023-08-30 (stale) with null industry + employeeCount' },
      { category: 'enrichment', recordIds: ['co_206'], note: 'Solstice never enriched (enrichedAt null)' },
      { category: 'enrichment', recordIds: ['co_207'], note: 'Maple enriched 2024-02-19 (stale)' },
    ],
  },
};
