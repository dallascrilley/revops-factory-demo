/**
 * RevOps Software Factory — deterministic engine.
 *
 * Pure, network-free helpers shared by the orchestrator function and the tests:
 *   - classifyRisk   — scale the agent team + coordinator model by blast radius
 *   - fuseFindings   — dedup + reasonableness-filter specialist output into one
 *                      approval-biased verdict (the coordinator's deterministic core)
 *   - costOf         — turn token usage into a dollar figure
 *   - cacheKey       — stable key for the run cache
 *
 * No LLM calls, no Workers APIs, no clock reads — everything here is a pure
 * function so it can be unit-tested directly with `node --test`. (Mirrors the
 * apexlint-demo engine pattern.)
 */
import type {
  Batch,
  Finding,
  RiskTier,
  Severity,
  Verdict,
} from './types.js';

// ── Models & pricing ────────────────────────────────────────────────────────

/**
 * OpenRouter model ids used by the factory. Specialists run on the `cheap` tier;
 * the coordinator runs `mid` for batches that need judgment. Routed through
 * OpenRouter (OpenAI-compatible) so the demo backend needs only an OpenRouter key.
 */
export const MODELS = {
  cheap: 'google/gemini-2.5-flash-lite',
  mid: 'google/gemini-2.5-flash',
} as const;

/**
 * List prices in USD per 1M tokens (OpenRouter list price for the models above).
 * Used by the cost ledger; update if pricing changes. These are the demo's
 * accounting inputs, not a pricing source of truth.
 */
export const RATES: Record<string, { input: number; output: number }> = {
  [MODELS.cheap]: { input: 0.1, output: 0.4 },
  [MODELS.mid]: { input: 0.3, output: 2.5 },
};

// ── Risk classification (R3) ─────────────────────────────────────────────────

export interface RiskProfile {
  tier: RiskTier;
  specialistCount: number;
  coordinatorModel: string;
}

const TRIVIAL_MAX_RECORDS = 8;
const LITE_MAX_RECORDS = 20;

/**
 * Scale compute by blast radius: small batches get a small team and a cheaper
 * coordinator; large batches get the full dream team on the top model. The score
 * is record count weighted by field-sensitivity (deals carry money + stage, so
 * they count double).
 */
export function classifyRisk(batch: Batch): RiskProfile {
  const score = batch.companies.length + batch.contacts.length + batch.deals.length * 2;

  let tier: RiskTier;
  if (score <= TRIVIAL_MAX_RECORDS) tier = 'trivial';
  else if (score <= LITE_MAX_RECORDS) tier = 'lite';
  else tier = 'full';

  const specialistCount = tier === 'trivial' ? 2 : tier === 'lite' ? 3 : 4;
  const coordinatorModel = tier === 'trivial' ? MODELS.cheap : MODELS.mid;
  return { tier, specialistCount, coordinatorModel };
}

// ── Fusion: dedup + reasonableness filter + verdict (R1) ─────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, suggestion: 1 };

/** Identity for dedup: the same problem on the same record from any specialist. */
function findingKey(f: Finding): string {
  return `${f.category}::${f.recordType}::${f.recordId}`;
}

function isWellFormed(f: Finding): boolean {
  return Boolean(
    f &&
      SEVERITY_RANK[f.severity] &&
      f.category &&
      f.recordType &&
      typeof f.recordId === 'string' &&
      f.recordId.trim() &&
      typeof f.claim === 'string' &&
      f.claim.trim() &&
      typeof f.evidence === 'string' &&
      f.evidence.trim(),
  );
}

export interface Fusion {
  findings: Finding[];
  verdict: Verdict;
  droppedCount: number;
}

/**
 * The coordinator's deterministic core. Takes the raw findings from every
 * specialist, drops malformed/speculative ones, dedups duplicates (keeping the
 * highest severity), sorts by severity, and emits an APPROVAL-BIASED verdict:
 * only a critical finding hard-blocks; warnings still ship as
 * approved_with_comments.
 */
export function fuseFindings(specialistOutputs: Finding[][]): Fusion {
  const incoming = specialistOutputs.flat();
  const wellFormed = incoming.filter(isWellFormed);
  const droppedMalformed = incoming.length - wellFormed.length;

  const byKey = new Map<string, Finding>();
  for (const f of wellFormed) {
    const key = findingKey(f);
    const existing = byKey.get(key);
    if (!existing || SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      byKey.set(key, f);
    }
  }

  const findings = [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  const verdict: Verdict = hasCritical
    ? 'requested_changes'
    : hasWarning
      ? 'approved_with_comments'
      : 'approve';

  const droppedDuplicates = wellFormed.length - findings.length;
  return { findings, verdict, droppedCount: droppedMalformed + droppedDuplicates };
}

// ── Cost accounting (R4) ─────────────────────────────────────────────────────

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Sum token usage across every agent call into one {tokens, usd} line. */
export function costOf(usages: ModelUsage[]): { tokens: number; usd: number } {
  let tokens = 0;
  let usd = 0;
  for (const u of usages) {
    const rate = RATES[u.model] ?? { input: 0, output: 0 };
    tokens += u.inputTokens + u.outputTokens;
    usd += (u.inputTokens / 1_000_000) * rate.input + (u.outputTokens / 1_000_000) * rate.output;
  }
  // Round to micro-dollars: the cheap models put a real run well under a cent,
  // so whole-cent rounding would collapse the ledger to $0.00. The UI formats.
  return { tokens, usd: Math.round(usd * 1_000_000) / 1_000_000 };
}

// ── Cache key (R5) ───────────────────────────────────────────────────────────

/** FNV-1a 32-bit — small, deterministic, no crypto dependency. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable cache key for a run: same batch + same model set → same key (so re-runs
 * hit the cache). Changing the model lineup or batch invalidates it.
 */
export function cacheKey(batchId: string, models: string[]): string {
  const modelset = [...models].sort().join(',');
  return `run:${batchId}:${fnv1a(modelset)}`;
}
