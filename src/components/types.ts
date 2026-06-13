/**
 * Shared types for the RevOps Software Factory.
 *
 * The factory reviews a BATCH of synthetic HubSpot-shaped CRM records. Four
 * specialist domains each own a category of finding; the coordinator fuses them
 * into one verdict. These types are the contract between the synthetic data
 * (src/data), the deterministic engine (engine.ts), the agents (src/agents), and
 * the orchestrator function (functions/api/review.ts).
 */

// ── CRM records (HubSpot-shaped, synthetic) ─────────────────────────────────

export interface Company {
  id: string;
  name: string;
  domain: string;
  industry: string | null;
  employeeCount: number | null;
  /** ISO date of last firmographic enrichment, or null if never enriched. */
  enrichedAt: string | null;
}

export interface Contact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId: string;
  lifecycleStage: 'subscriber' | 'lead' | 'mql' | 'sql' | 'opportunity' | 'customer';
}

export type DealStage =
  | 'appointmentscheduled'
  | 'qualifiedtobuy'
  | 'presentationscheduled'
  | 'decisionmakerboughtin'
  | 'contractsent'
  | 'closedwon'
  | 'closedlost';

export interface Deal {
  id: string;
  name: string;
  amount: number;
  stage: DealStage;
  /** ISO date the deal is expected/was closed, or null. */
  closeDate: string | null;
  companyId: string;
  /** Marketing attribution: contact ids credited with first/last touch. */
  attribution: { firstTouch: string | null; lastTouch: string | null };
}

// ── Batch & risk tiers ──────────────────────────────────────────────────────

export type RiskTier = 'trivial' | 'lite' | 'full';

export interface Batch {
  id: string;
  tier: RiskTier;
  label: string;
  description: string;
  companies: Company[];
  contacts: Contact[];
  deals: Deal[];
}

// ── Findings & verdicts ─────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'suggestion';

/** The four specialist domains, one per reviewer agent. */
export type FindingCategory = 'dedup' | 'attribution' | 'stage-logic' | 'enrichment';

export type RecordType = 'company' | 'contact' | 'deal';

export interface Finding {
  severity: Severity;
  category: FindingCategory;
  recordType: RecordType;
  /** The primary record this finding is about (e.g. the duplicate, the bad deal). */
  recordId: string;
  /** One-line statement of the problem. */
  claim: string;
  /** Why it's a problem — the specific evidence in the data. */
  evidence: string;
}

export type Verdict = 'approve' | 'approved_with_comments' | 'requested_changes';

// ── Run trace & cost ────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostLine {
  tokens: number;
  usd: number;
}

/** How a returned run was served — kept truthful in the UI. */
export type ServedAs = 'fresh' | 'cached' | 'failback';

export interface ReviewResult {
  batchId: string;
  tier: RiskTier;
  specialistCount: number;
  coordinatorModel: string;
  findings: Finding[];
  verdict: Verdict;
  breakGlass: boolean;
  cost: CostLine;
  cacheHitRate: number;
  servedAs: ServedAs;
}
