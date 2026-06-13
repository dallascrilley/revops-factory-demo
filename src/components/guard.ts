/**
 * Safety / resilience guard (R5) — what makes the live LLM backend safe on a
 * public page, and what the demo actually shows off.
 *
 * Before a run we decide how to serve it:
 *   - cache HIT      → return the stored real run (instant, ~free)
 *   - rate/budget OK → run FRESH, then cache it + record spend
 *   - exceeded       → FAILBACK to the last good cached run (with a reason)
 *   - exceeded + no cache → ERROR (nothing safe to serve)
 *
 * Everything goes through a minimal `KVLike` so it's unit-testable with an
 * in-memory map; Cloudflare's KVNamespace satisfies the same shape. `today` is
 * injected (no clock read here) for deterministic tests.
 */
import type { RunResult } from './orchestrator.js';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface GuardConfig {
  /** Global daily token ceiling across all visitors. */
  dailyTokenCap: number;
  /** Max fresh runs per IP per window. */
  ratePerWindow: number;
  windowSec: number;
  /** YYYY-MM-DD, injected by the caller (function uses the request date). */
  today: string;
}

export type ServeMode = 'cached' | 'fresh' | 'failback' | 'error';

export interface ServeDecision {
  mode: ServeMode;
  cached?: RunResult;
  reason?: string;
  cacheHitRate: number;
}

const LAST_GOOD_KEY = 'run:last-good';
const statKey = (k: 'hits' | 'total') => `stat:${k}`;
const budgetKey = (day: string) => `budget:${day}`;
const rateKey = (ip: string) => `rl:${ip}`;

async function num(kv: KVLike, key: string): Promise<number> {
  const v = await kv.get(key);
  const n = v === null ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function cacheHitRate(kv: KVLike): Promise<number> {
  const total = await num(kv, statKey('total'));
  if (!total) return 0;
  const hits = await num(kv, statKey('hits'));
  return Math.round((hits / total) * 100) / 100;
}

/** Decide how to serve this run. Mutates rate/stat counters as a side effect. */
export async function decideServe(
  kv: KVLike,
  cacheKey: string,
  ip: string,
  cfg: GuardConfig,
): Promise<ServeDecision> {
  await kv.put(statKey('total'), String((await num(kv, statKey('total'))) + 1));

  // 1. Cache hit — cheapest path.
  const cachedRaw = await kv.get(`cache:${cacheKey}`);
  if (cachedRaw) {
    await kv.put(statKey('hits'), String((await num(kv, statKey('hits'))) + 1));
    return { mode: 'cached', cached: JSON.parse(cachedRaw) as RunResult, cacheHitRate: await cacheHitRate(kv) };
  }

  // 2. Rate limit (per IP) + 3. global daily token budget.
  const rate = (await num(kv, rateKey(ip))) + 1;
  await kv.put(rateKey(ip), String(rate), { expirationTtl: cfg.windowSec });
  const spent = await num(kv, budgetKey(cfg.today));

  const overRate = rate > cfg.ratePerWindow;
  const overBudget = spent >= cfg.dailyTokenCap;

  if (overRate || overBudget) {
    const reason = overBudget ? 'daily token budget reached' : 'rate limit reached';
    const lastRaw = await kv.get(LAST_GOOD_KEY);
    if (lastRaw) {
      return { mode: 'failback', cached: JSON.parse(lastRaw) as RunResult, reason, cacheHitRate: await cacheHitRate(kv) };
    }
    return { mode: 'error', reason: `${reason} and no cached run to serve`, cacheHitRate: await cacheHitRate(kv) };
  }

  return { mode: 'fresh', cacheHitRate: await cacheHitRate(kv) };
}

/** After a fresh run completes, persist it and record the spend. */
export async function commitFreshRun(
  kv: KVLike,
  cacheKey: string,
  result: RunResult,
  cfg: GuardConfig,
): Promise<void> {
  const payload = JSON.stringify(result);
  await kv.put(`cache:${cacheKey}`, payload, { expirationTtl: 60 * 60 * 24 });
  await kv.put(LAST_GOOD_KEY, payload);
  const spent = await num(kv, budgetKey(cfg.today));
  await kv.put(budgetKey(cfg.today), String(spent + result.cost.tokens), { expirationTtl: 60 * 60 * 36 });
}
