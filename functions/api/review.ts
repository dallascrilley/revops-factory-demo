/**
 * RevOps Software Factory — orchestrator Pages Function (POST /api/review).
 *
 * STUB (U1). The full pipeline is built in later units:
 *   U5 — classify batch → dispatch specialist agents concurrently → coordinator
 *        fusion → stream a JSONL trace + token-cost totals.
 *   U6 — wrap it in the KV cache / per-IP rate limit / daily token budget guard,
 *        with provider-timeout failback and budget-exhaustion failback to the last
 *        cached real run.
 *
 * All model traffic stays server-side here; the front end only POSTs { batchId }.
 */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export async function onRequestPost(): Promise<Response> {
  return json({ ok: true, stub: true });
}
