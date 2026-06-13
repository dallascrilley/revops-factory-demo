/**
 * Enrichment-freshness specialist — finds companies that are stale or were never
 * enriched. Reads only companies.
 */
import { MODELS } from '../components/engine.js';
import type { Batch } from '../components/types.js';
import {
  ANTI_SPEC,
  FINDING_FORMAT,
  REFERENCE_DATE,
  type AgentCall,
  type Specialist,
} from './client.js';

export const enrichment: Specialist = {
  category: 'enrichment',
  model: MODELS.haiku,

  slice(batch: Batch) {
    return {
      companies: batch.companies.map((c) => ({
        id: c.id,
        name: c.name,
        enrichedAt: c.enrichedAt,
        industry: c.industry,
        employeeCount: c.employeeCount,
      })),
    };
  },

  buildCall(batch: Batch, shared: string): AgentCall {
    const system = [
      'You are the ENRICHMENT-FRESHNESS reviewer on a RevOps data-integrity team.',
      'Flag companies whose firmographic data is unreliable:',
      `- enrichedAt is null (never enriched) or more than ~12 months before ${REFERENCE_DATE}`,
      '- core fields (industry, employeeCount) are null',
      'Use category "enrichment". A stale record with null core fields is more severe',
      'than one that is merely a little old.',
      '',
      ANTI_SPEC,
      '',
      FINDING_FORMAT,
    ].join('\n');
    const user = `${shared}\n\nRecords to inspect:\n${JSON.stringify(this.slice(batch), null, 2)}`;
    return { label: 'enrichment', model: this.model, system, user };
  },
};
