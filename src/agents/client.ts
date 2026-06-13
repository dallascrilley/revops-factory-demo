/**
 * Agent transport + shared prompt scaffolding.
 *
 * All specialists and the coordinator talk to the model through a `Transport`.
 * In production that's `anthropicTransport` (a raw fetch to the Messages API — no
 * SDK, so it bundles cleanly into a Workers/Pages Function). In tests it's
 * `fixtureTransport`, which replays recorded responses keyed by agent label — no
 * network, deterministic. This is the "fixture mode" the plan calls for.
 */
import type { Batch, Finding, FindingCategory, TokenUsage } from '../components/types.js';

/** A specialist reviewer: its domain, model tier, the record slice it reads, and
 * how it assembles its model call. Keeping `slice` separate makes the
 * diff-partitioning (each agent reads only what it needs) explicit and testable. */
export interface Specialist {
  category: FindingCategory;
  model: string;
  slice(batch: Batch): Record<string, unknown>;
  buildCall(batch: Batch, shared: string): AgentCall;
}

/**
 * The under-used prompt skill (rated A-tier in the source material): tell the
 * model what NOT to flag. Injected into every specialist's system prompt to keep
 * the finding count deliberately low and signal-rich.
 */
export const ANTI_SPEC = [
  'Do NOT flag:',
  '- stylistic or naming preferences (record naming, casing of labels)',
  '- speculative issues you cannot point to specific evidence for',
  '- valid business states that merely look unusual (large deals, long sales cycles)',
  '- anything already correct that you would only "double-check"',
  'Only report a finding when you can cite the exact field(s) and record id(s) that',
  'prove the problem. When in doubt, do not flag. Fewer, higher-signal findings win.',
].join('\n');

/** The reference "today" for the synthetic data, so past-due detection is stable. */
export const REFERENCE_DATE = '2026-06-13';

export interface AgentCall {
  /** Agent identity, e.g. 'dedup' or 'coordinator' — used to key fixtures. */
  label: string;
  model: string;
  system: string;
  user: string;
}

export interface AgentRaw {
  text: string;
  usage: TokenUsage;
}

export type Transport = (call: AgentCall) => Promise<AgentRaw>;

/** Replays recorded responses by label. Throws if a label is missing so a stale
 * fixture set fails loudly rather than silently returning nothing. */
export function fixtureTransport(fixtures: Record<string, AgentRaw>): Transport {
  return async (call) => {
    const hit = fixtures[call.label];
    if (!hit) throw new Error(`no fixture for agent label "${call.label}"`);
    return hit;
  };
}

/** Live transport: one POST to the Anthropic Messages API per agent call. */
export function anthropicTransport(apiKey: string, fetchImpl: typeof fetch = fetch): Transport {
  return async (call) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: 2048,
        system: call.system,
        messages: [{ role: 'user', content: call.user }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${call.label} call failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  };
}

/**
 * Extract a JSON array of findings from model text. Tolerant of prose or code
 * fences around the array; returns [] if nothing parseable is found. Downstream
 * fusion (engine.fuseFindings) drops anything malformed, so this stays lenient.
 */
export function parseFindings(text: string): Finding[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as Finding[]) : [];
  } catch {
    return [];
  }
}

/** Build the shared MR-context blob, written once and reused by every agent so
 * its token cost isn't multiplied across the team. */
export function sharedContext(batch: { id: string; label: string; companies: unknown[]; contacts: unknown[]; deals: unknown[] }): string {
  return [
    `Synthetic CRM batch "${batch.id}" — ${batch.label}.`,
    `Today's date is ${REFERENCE_DATE}.`,
    `Counts: ${batch.companies.length} companies, ${batch.contacts.length} contacts, ${batch.deals.length} deals.`,
    'You are one reviewer on a multi-agent RevOps data-integrity team. Stay strictly',
    'within your assigned domain; other specialists cover the rest.',
  ].join('\n');
}

/** Findings are requested in this exact JSON shape from every specialist. */
export const FINDING_FORMAT = [
  'Respond with ONLY a JSON array (no prose) of findings in this shape:',
  '[{"severity":"critical|warning|suggestion","category":"<your category>",',
  '  "recordType":"company|contact|deal","recordId":"<id>",',
  '  "claim":"<one line>","evidence":"<the exact fields proving it>"}]',
  'If there is nothing to report, respond with [].',
].join('\n');
