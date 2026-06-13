# RevOps Software Factory

> A coordinator + specialist agents review a synthetic HubSpot CRM batch and return
> one approval-biased verdict — with a live token-cost ledger proving the
> "review your revenue pipeline for ~$1 instead of an analyst-day" thesis.

This is a **public portfolio demo**. It ports Cloudflare's multi-agent code-review
"software factory" ([Orchestrating AI Code Review at scale](https://blog.cloudflare.com/ai-code-review/))
into the RevOps domain: instead of reviewing a merge request, it reviews a batch of
revenue records.

**Honest boundary:** the data is **synthetic** (no real CRM, no client data). The
agents make **real** Anthropic model calls server-side, fronted by a cache + budget +
rate-limit guard so a public page can't run up an unbounded bill. Most runs serve a
**cached real run**; the UI always tells you whether a run was `fresh`, `cached`, or a
`failback`.

## How it works

```
Pick a synthetic batch (Trivial / Lite / Full) ─▶ POST /api/review { batchId }
        │
        ▼  Cloudflare Pages Function
  cache lookup ──hit─▶ return cached real run (instant, ~free)
  per-IP rate limit + global daily token budget ──exceeded─▶ failback to cached run
  classify risk (rows × field-sensitivity) → trivial=2 / lite=3 / full=4 specialists
  dispatch specialists concurrently (Haiku): dedup · attribution · stage-logic · enrichment
    each reads only its record slice + a shared-context blob written once
  coordinator (Sonnet): dedup → re-categorize → reasonableness filter → approval-biased verdict
  emit JSONL trace + token/cost totals
        ▼
  verdict card + live cost ledger (tokens · $ · cache-hit % · vs human-analyst baseline)
```

## Run locally

```bash
pnpm install
pnpm build && npx wrangler pages dev dist   # serve site + functions
# live runs need: a secret ANTHROPIC_API_KEY and a FACTORY_KV namespace binding
```

```bash
pnpm test    # deterministic engine + fixture-mode agent tests (no network)
```

## Layout

```
src/components/  types.ts · engine.ts (pure: risk classifier, fusion, cost, cache-key) · app.ts (client)
src/agents/      dedup · attribution · stage-logic · enrichment · coordinator · client (+ fixture mode)
src/data/        batches/{trivial,lite,full}.json · expected-findings.ts
functions/api/   review.ts (orchestrator + guard)
tests/           engine + fixture tests
```

MIT licensed. Part of [dallascrilley.com](https://dallascrilley.com) portfolio demos.
