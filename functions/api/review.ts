/**
 * RevOps Software Factory — orchestrator Pages Function (POST /api/review).
 *
 * Thin Workers adapter. Flow:
 *   1. Resolve the synthetic batch + the model set, compute the cache key.
 *   2. Guard (src/components/guard.ts) decides: cached | fresh | failback | error.
 *      - cached/failback → emit a short NDJSON trace (served + verdict).
 *      - fresh → stream the orchestrator's JSONL trace, then cache it + record spend.
 *   3. Break glass overrides the verdict to "approve" on any served result.
 *
 * All run logic is in src/components/orchestrator.ts; the guard makes the live
 * OpenRouter backend safe on a public page (cache + per-IP rate limit + daily
 * token budget, with failback to the last good run).
 */
import { runReview, type RunResult } from '../../src/components/orchestrator.js';
import { classifyRisk, cacheKey, MODELS } from '../../src/components/engine.js';
import { decideServe, commitFreshRun, type KVLike, type GuardConfig } from '../../src/components/guard.js';
import { openrouterTransport } from '../../src/agents/client.js';
import type { Batch } from '../../src/components/types.js';
import trivial from '../../src/data/batches/trivial.json';
import lite from '../../src/data/batches/lite.json';
import full from '../../src/data/batches/full.json';

const BATCHES: Record<string, Batch> = {
  trivial: trivial as Batch,
  lite: lite as Batch,
  full: full as Batch,
};

interface Env {
  OPENROUTER_API_KEY?: string;
  FACTORY_KV?: KVLike;
  DAILY_TOKEN_CAP?: string;
  RATE_PER_WINDOW?: string;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
};

function applyBreakGlass(result: RunResult, breakGlass: boolean): RunResult {
  return breakGlass ? { ...result, verdict: 'approve', breakGlass: true } : result;
}

/** One-shot NDJSON body for a result we already have (cached / failback). */
function servedResponse(
  result: RunResult,
  servedAs: 'cached' | 'failback',
  reason: string | undefined,
  cacheHitRate: number,
): Response {
  const lines = [
    JSON.stringify({ type: 'served', servedAs, reason, cacheHitRate }),
    JSON.stringify({ type: 'verdict', result }),
  ];
  return new Response(lines.join('\n') + '\n', { headers: NDJSON_HEADERS });
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  let body: { batchId?: string; breakGlass?: boolean };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return jsonError('Body must be JSON: { batchId, breakGlass? }');
  }

  const batch = body.batchId ? BATCHES[body.batchId] : undefined;
  if (!batch) return jsonError(`Unknown batchId. Choose one of: ${Object.keys(BATCHES).join(', ')}`);
  if (!context.env.OPENROUTER_API_KEY) return jsonError('Server missing OPENROUTER_API_KEY.', 500);

  const breakGlass = Boolean(body.breakGlass);
  const profile = classifyRisk(batch);
  const modelset = Array.from(new Set([MODELS.cheap, profile.coordinatorModel]));
  const key = cacheKey(batch.id, modelset);
  const kv = context.env.FACTORY_KV;
  const transport = openrouterTransport(context.env.OPENROUTER_API_KEY);
  const encoder = new TextEncoder();

  // Guard decision (skipped only when no KV is bound, e.g. bare local dev).
  let cacheHitRate = 0;
  let commit: ((result: RunResult) => Promise<void>) | undefined;
  if (kv) {
    const cfg: GuardConfig = {
      dailyTokenCap: Number(context.env.DAILY_TOKEN_CAP) || 5_000_000,
      ratePerWindow: Number(context.env.RATE_PER_WINDOW) || 10,
      windowSec: 3600,
      today: new Date().toISOString().slice(0, 10),
    };
    const ip = context.request.headers.get('cf-connecting-ip') || 'anon';
    const decision = await decideServe(kv, key, ip, cfg);
    cacheHitRate = decision.cacheHitRate;

    if (decision.mode === 'error') return jsonError(decision.reason || 'Unavailable', 429);
    if (decision.mode === 'cached' || decision.mode === 'failback') {
      return servedResponse(applyBreakGlass(decision.cached!, breakGlass), decision.mode, decision.reason, cacheHitRate);
    }
    // fresh: fall through, committing after the run.
    commit = async (result: RunResult) => commitFreshRun(kv, key, result, cfg);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      try {
        emit({ type: 'served', servedAs: 'fresh', cacheHitRate });
        let finalResult: RunResult | undefined;
        for await (const event of runReview(batch, { transport, breakGlass, timeoutMs: 20_000 })) {
          if (event.type === 'verdict') {
            finalResult = applyBreakGlass(event.result, breakGlass);
            emit({ type: 'verdict', result: finalResult });
          } else {
            emit(event);
          }
        }
        if (finalResult && typeof commit === 'function') await commit(finalResult);
      } catch (e) {
        emit({ type: 'fatal', message: String((e as Error)?.message ?? e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
