/**
 * Local E2E harness — serves the built site and streams /api/review using
 * FIXTURE transport (no live LLM, no Workers runtime). Per
 * docs/solutions/tooling/pages-dev-proxy-e2e-harness.md we use a plain Node HTTP
 * server instead of `wrangler pages dev`, which hangs on local requests.
 *
 *   node tests/e2e-harness.mjs [port]
 *
 * Requires `pnpm build` (dist/) and `pnpm build:test-engine` (tests/.engine-build/).
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { runReview } from './.engine-build/components/orchestrator.js';
import { fixtureTransport } from './.engine-build/agents/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const load = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));

const batches = {
  trivial: load('../src/data/batches/trivial.json'),
  lite: load('../src/data/batches/lite.json'),
  full: load('../src/data/batches/full.json'),
};

// Fixture set covering every specialist label + coordinator, so any batch renders.
const liteFx = load('./fixtures/lite.json');
const fixtures = {
  ...liteFx,
  enrichment: {
    text: JSON.stringify([
      { severity: 'critical', category: 'enrichment', recordType: 'company', recordId: 'co_206', claim: 'Never enriched', evidence: 'enrichedAt is null' },
      { severity: 'warning', category: 'enrichment', recordType: 'company', recordId: 'co_204', claim: 'Stale firmographics', evidence: 'enrichedAt 2023-08-30, null industry + employeeCount' },
    ]),
    usage: { inputTokens: 600, outputTokens: 70 },
  },
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/review') {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const batch = batches[body.batchId] || batches.lite;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'served', servedAs: 'fresh', cacheHitRate: 0 }) + '\n');
    for await (const e of runReview(batch, { transport: fixtureTransport(fixtures), breakGlass: Boolean(body.breakGlass) })) {
      res.write(JSON.stringify(e) + '\n');
    }
    res.end();
    return;
  }

  // Static files from dist/.
  let path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let file = join(dist, path);
  if (!existsSync(file)) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const port = Number(process.argv[2]) || 4399;
server.listen(port, () => console.log(`e2e-harness on http://127.0.0.1:${port}`));
