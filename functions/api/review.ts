/**
 * RevOps Software Factory — orchestrator Pages Function (POST /api/review).
 *
 * Thin Workers adapter: load the requested synthetic batch, wire the live
 * Anthropic transport, and stream the orchestrator's JSONL trace to the client.
 * All run logic lives in src/components/orchestrator.ts (network-free, tested via
 * the Node HTTP harness). The KV cache / rate-limit / budget guard is layered in
 * by U6.
 */
import { runReview } from '../../src/components/orchestrator.js';
import { anthropicTransport } from '../../src/agents/client.js';
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
  ANTHROPIC_API_KEY?: string;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  let body: { batchId?: string; breakGlass?: boolean };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return jsonError('Body must be JSON: { batchId, breakGlass? }');
  }

  const batch = body.batchId ? BATCHES[body.batchId] : undefined;
  if (!batch) return jsonError(`Unknown batchId. Choose one of: ${Object.keys(BATCHES).join(', ')}`);
  if (!context.env.ANTHROPIC_API_KEY) return jsonError('Server missing ANTHROPIC_API_KEY.', 500);

  const transport = anthropicTransport(context.env.ANTHROPIC_API_KEY);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runReview(batch, {
          transport,
          breakGlass: Boolean(body.breakGlass),
          timeoutMs: 20_000,
        })) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'fatal', message: String((e as Error)?.message ?? e) }) + '\n'),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
