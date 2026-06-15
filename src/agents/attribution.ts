/**
 * Attribution-integrity specialist — finds deals whose first/last touch credit a
 * contact that doesn't belong to the deal's company, or that have no attribution
 * at all. Reads deals (with attribution) plus the contact→company map.
 */
import { MODELS } from '../components/engine.js';
import type { Batch } from '../components/types.js';
import {
  ANTI_SPEC,
  FINDING_FORMAT,
  type AgentCall,
  type Specialist,
} from './client.js';

export const attribution: Specialist = {
  category: 'attribution',
  model: MODELS.cheap,

  slice(batch: Batch) {
    return {
      deals: batch.deals.map((d) => ({ id: d.id, name: d.name, companyId: d.companyId, stage: d.stage, attribution: d.attribution })),
      contacts: batch.contacts.map((c) => ({ id: c.id, companyId: c.companyId })),
    };
  },

  buildCall(batch: Batch, shared: string): AgentCall {
    const system = [
      'You are the ATTRIBUTION-INTEGRITY reviewer on a RevOps data-integrity team.',
      'For each deal, check its attribution.firstTouch and attribution.lastTouch.',
      'Flag: a touch crediting a contact whose companyId differs from the deal\'s',
      'companyId (cross-company attribution), and advanced-stage deals',
      '(contractsent/closedwon) with no attribution at all (both touches null).',
      'Use category "attribution".',
      '',
      ANTI_SPEC,
      '',
      FINDING_FORMAT,
    ].join('\n');
    const user = `${shared}\n\nRecords to inspect:\n${JSON.stringify(this.slice(batch), null, 2)}`;
    return { label: 'attribution', model: this.model, system, user };
  },
};
