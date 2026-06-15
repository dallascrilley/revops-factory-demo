/**
 * Stage & pipeline-logic specialist — finds deals in impossible states. Reads
 * only deals (the single record type it needs).
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

export const stageLogic: Specialist = {
  category: 'stage-logic',
  model: MODELS.cheap,

  slice(batch: Batch) {
    return {
      deals: batch.deals.map((d) => ({ id: d.id, name: d.name, amount: d.amount, stage: d.stage, closeDate: d.closeDate })),
    };
  },

  buildCall(batch: Batch, shared: string): AgentCall {
    const system = [
      'You are the STAGE & PIPELINE-LOGIC reviewer on a RevOps data-integrity team.',
      'Flag deals in impossible or contradictory states:',
      '- closedwon with amount 0 or a null closeDate',
      '- a negative amount',
      `- an open stage (not closedwon/closedlost) whose closeDate is in the past (before ${REFERENCE_DATE})`,
      'Use category "stage-logic".',
      '',
      ANTI_SPEC,
      '',
      FINDING_FORMAT,
    ].join('\n');
    const user = `${shared}\n\nRecords to inspect:\n${JSON.stringify(this.slice(batch), null, 2)}`;
    return { label: 'stage-logic', model: this.model, system, user };
  },
};
