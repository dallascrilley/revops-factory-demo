/**
 * Coordinator — the judge pass. After the deterministic engine dedups and sorts
 * the specialists' findings (engine.fuseFindings), the coordinator LLM does the
 * reasonableness pass: it writes the single human-readable review summary and may
 * SUPPRESS findings it judges unreasonable or contradictory. The verdict itself
 * stays deterministic (engine) so it can't drift; the coordinator shapes the
 * narrative and trims false positives — the parts that need judgment.
 */
import type { Finding, Verdict } from '../components/types.js';
import { ANTI_SPEC, type AgentCall } from './client.js';

export interface CoordinatorOutput {
  summary: string;
  /** recordIds whose findings the coordinator judged unreasonable; engine result minus these. */
  suppressRecordIds: string[];
}

const COORD_FORMAT = [
  'Respond with ONLY a JSON object:',
  '{"summary":"<2-3 sentence reviewer summary for the RevOps owner>",',
  ' "suppressRecordIds":["<recordId>", ...]}',
  'Put a recordId in suppressRecordIds ONLY if a flagged finding is clearly a false',
  'positive or contradicts another finding. Usually this list is empty.',
].join('\n');

export function buildCoordinatorCall(
  findings: Finding[],
  verdict: Verdict,
  shared: string,
  model: string,
): AgentCall {
  const system = [
    'You are the COORDINATOR of a RevOps data-integrity review. Specialist agents',
    'have already produced and deduplicated findings. Your job: a reasonableness',
    'pass. Write one concise summary for the data owner and suppress any finding',
    'that is clearly a false positive or contradicts another. Bias toward approval —',
    `the deterministic verdict is already "${verdict}"; do not try to override it,`,
    'just explain it fairly and trim noise.',
    '',
    ANTI_SPEC,
    '',
    COORD_FORMAT,
  ].join('\n');
  const user = [
    shared,
    '',
    `Deterministic verdict: ${verdict}`,
    `Deduplicated findings (${findings.length}):`,
    JSON.stringify(findings, null, 2),
  ].join('\n');
  return { label: 'coordinator', model, system, user };
}

/** Parse the coordinator's JSON object; tolerant of fences/prose. */
export function parseCoordinator(text: string): CoordinatorOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const fallback: CoordinatorOutput = { summary: '', suppressRecordIds: [] };
  if (start === -1 || end === -1 || end < start) return fallback;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Partial<CoordinatorOutput>;
    return {
      summary: typeof o.summary === 'string' ? o.summary : '',
      suppressRecordIds: Array.isArray(o.suppressRecordIds) ? o.suppressRecordIds.map(String) : [],
    };
  } catch {
    return fallback;
  }
}
