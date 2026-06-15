/**
 * Orchestrator — the factory run, as a transport-injected async generator.
 *
 * Yields a JSONL-friendly trace as it goes (classify → specialists → fusion →
 * coordinator → cost → verdict) so the Pages Function can stream it line by line
 * (valid-at-every-line, per the source's "stream with JSONL" lesson). The
 * transport is injected, so tests drive it with fixtures and production wires the
 * live Anthropic transport — the orchestration logic itself is network-free and
 * unit-testable.
 *
 * Resilience (R5): every model call runs under a timeout with a single failback
 * to a cheaper previous-gen model. A specialist that still fails is dropped to a
 * degraded "no findings" state — the run continues rather than dying.
 */
import {
  classifyRisk,
  fuseFindings,
  costOf,
  MODELS,
  type ModelUsage,
} from './engine.js';
import type { Batch, Finding, Verdict } from './types.js';
import {
  sharedContext,
  parseFindings,
  type AgentCall,
  type Transport,
} from '../agents/client.js';
import { selectSpecialists } from '../agents/index.js';
import { buildCoordinatorCall, parseCoordinator } from '../agents/coordinator.js';

export type TraceEvent =
  | { type: 'classified'; tier: string; specialistCount: number; coordinatorModel: string }
  | { type: 'agent_start'; label: string; model: string }
  | { type: 'agent_done'; label: string; findingCount: number; failedBack: boolean }
  | { type: 'agent_error'; label: string; message: string }
  | { type: 'fused'; verdict: Verdict; findingCount: number; droppedCount: number }
  | { type: 'coordinator_done'; summary: string; suppressedCount: number }
  | { type: 'cost'; tokens: number; usd: number }
  | { type: 'verdict'; result: RunResult };

export interface RunResult {
  batchId: string;
  tier: string;
  specialistCount: number;
  coordinatorModel: string;
  findings: Finding[];
  verdict: Verdict;
  summary: string;
  breakGlass: boolean;
  cost: { tokens: number; usd: number };
}

export interface RunOptions {
  transport: Transport;
  breakGlass?: boolean;
  /** Per-call timeout in ms (default 0 = no timeout, used by fixture tests). */
  timeoutMs?: number;
}

/** Cheaper model to fail back to for a given model. */
function fallbackModel(model: string): string {
  return model === MODELS.mid ? MODELS.cheap : MODELS.cheap;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

interface ResilientCall {
  text: string;
  usage: ModelUsage;
  failedBack: boolean;
}

async function callWithResilience(
  transport: Transport,
  call: AgentCall,
  timeoutMs: number,
): Promise<ResilientCall> {
  try {
    const raw = await withTimeout(transport(call), timeoutMs);
    return { text: raw.text, usage: { model: call.model, ...raw.usage }, failedBack: false };
  } catch {
    const fb = fallbackModel(call.model);
    const raw = await withTimeout(transport({ ...call, model: fb }), timeoutMs);
    return { text: raw.text, usage: { model: fb, ...raw.usage }, failedBack: true };
  }
}

export async function* runReview(batch: Batch, opts: RunOptions): AsyncGenerator<TraceEvent> {
  const { transport, breakGlass = false, timeoutMs = 0 } = opts;
  const profile = classifyRisk(batch);
  const usages: ModelUsage[] = [];
  yield { type: 'classified', ...profile };

  const shared = sharedContext(batch);
  const specialists = selectSpecialists(profile.tier);

  // Dispatch specialists concurrently; collect findings as they settle.
  const calls = specialists.map((s) => ({ s, call: s.buildCall(batch, shared) }));
  for (const { call } of calls) yield { type: 'agent_start', label: call.label, model: call.model };

  const settled = await Promise.allSettled(
    calls.map(({ call }) => callWithResilience(transport, call, timeoutMs)),
  );

  const specialistFindings: Finding[][] = [];
  for (let i = 0; i < settled.length; i++) {
    const { call } = calls[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      usages.push(r.value.usage);
      const findings = parseFindings(r.value.text);
      specialistFindings.push(findings);
      yield { type: 'agent_done', label: call.label, findingCount: findings.length, failedBack: r.value.failedBack };
    } else {
      specialistFindings.push([]);
      yield { type: 'agent_error', label: call.label, message: String(r.reason?.message ?? r.reason) };
    }
  }

  const fusion = fuseFindings(specialistFindings);
  yield { type: 'fused', verdict: fusion.verdict, findingCount: fusion.findings.length, droppedCount: fusion.droppedCount };

  // Coordinator judge pass (reasonableness + summary). Degrade gracefully on failure.
  let summary = '';
  let findings = fusion.findings;
  try {
    const coordCall = buildCoordinatorCall(fusion.findings, fusion.verdict, shared, profile.coordinatorModel);
    const raw = await callWithResilience(transport, coordCall, timeoutMs);
    usages.push(raw.usage);
    const coord = parseCoordinator(raw.text);
    summary = coord.summary;
    if (coord.suppressRecordIds.length) {
      const suppress = new Set(coord.suppressRecordIds);
      findings = findings.filter((f) => !suppress.has(f.recordId));
    }
    yield { type: 'coordinator_done', summary, suppressedCount: coord.suppressRecordIds.length };
  } catch (e) {
    yield { type: 'agent_error', label: 'coordinator', message: String((e as Error)?.message ?? e) };
  }

  const cost = costOf(usages);
  yield { type: 'cost', ...cost };

  // Break glass forces approval regardless of findings (R6).
  const verdict: Verdict = breakGlass ? 'approve' : fusion.verdict;
  const result: RunResult = {
    batchId: batch.id,
    tier: profile.tier,
    specialistCount: profile.specialistCount,
    coordinatorModel: profile.coordinatorModel,
    findings,
    verdict,
    summary,
    breakGlass,
    cost,
  };
  yield { type: 'verdict', result };
}
