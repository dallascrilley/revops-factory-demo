/**
 * Specialist roster + per-tier selection.
 *
 * Risk-scaled compute (R3): a trivial batch gets a 2-agent team, lite gets 3,
 * full gets the whole roster of 4. The selection per tier is explicit (not just
 * "first N") so each tier reviews the domains that matter most for its blast
 * radius — and so the synthetic batches always have something for their team to
 * find. The counts here must match engine.classifyRisk (2 / 3 / 4).
 */
import type { RiskTier } from '../components/types.js';
import type { Specialist } from './client.js';
import { dedup } from './dedup.js';
import { attribution } from './attribution.js';
import { stageLogic } from './stage-logic.js';
import { enrichment } from './enrichment.js';

export const ALL_SPECIALISTS: Specialist[] = [dedup, attribution, stageLogic, enrichment];

const BY_TIER: Record<RiskTier, Specialist[]> = {
  trivial: [stageLogic, enrichment],
  lite: [dedup, stageLogic, attribution],
  full: [dedup, attribution, stageLogic, enrichment],
};

export function selectSpecialists(tier: RiskTier): Specialist[] {
  return BY_TIER[tier];
}
