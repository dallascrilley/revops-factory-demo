/**
 * Dedup / identity specialist — finds duplicate companies, contacts, and deals.
 * Reads the identity-bearing fields across all three record types (duplicates
 * span types), but only those fields.
 */
import { MODELS } from '../components/engine.js';
import type { Batch } from '../components/types.js';
import {
  ANTI_SPEC,
  FINDING_FORMAT,
  type AgentCall,
  type Specialist,
} from './client.js';

export const dedup: Specialist = {
  category: 'dedup',
  model: MODELS.haiku,

  slice(batch: Batch) {
    return {
      companies: batch.companies.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
      contacts: batch.contacts.map((c) => ({ id: c.id, email: c.email, companyId: c.companyId })),
      deals: batch.deals.map((d) => ({ id: d.id, name: d.name, amount: d.amount, companyId: d.companyId, closeDate: d.closeDate })),
    };
  },

  buildCall(batch: Batch, shared: string): AgentCall {
    const system = [
      'You are the DEDUP / IDENTITY reviewer on a RevOps data-integrity team.',
      'Find duplicate records: companies sharing a domain, contacts sharing an email',
      '(treat email case-insensitively), and deals that are clearly the same deal',
      'entered twice (same company, amount, and close date). Use category "dedup".',
      '',
      ANTI_SPEC,
      '',
      FINDING_FORMAT,
    ].join('\n');
    const user = `${shared}\n\nRecords to inspect:\n${JSON.stringify(this.slice(batch), null, 2)}`;
    return { label: 'dedup', model: this.model, system, user };
  },
};
