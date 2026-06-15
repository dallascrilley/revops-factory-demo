/**
 * RevOps Software Factory — client. Posts a batch to /api/review, reads the
 * NDJSON trace incrementally, and animates the agent lanes → findings → verdict
 * → cost ledger. Handles both the streamed fresh run and the one-shot
 * cached/failback response (served + verdict only).
 */

// Illustrative human baseline for the ledger — a generic analyst-review cost,
// no real client figures. ~3 hours of a RevOps analyst at a round rate.
const HUMAN_BASELINE_USD = 420;

// The cheap models put a real run well under a cent, so a flat 2-decimal format
// would read "$0.00". Show whole cents above a cent, micro-dollars below.
function fmtUsd(usd: number): string {
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

type Severity = 'critical' | 'warning' | 'suggestion';
interface Finding {
  severity: Severity;
  category: string;
  recordType: string;
  recordId: string;
  claim: string;
  evidence: string;
}
interface RunResult {
  verdict: 'approve' | 'approved_with_comments' | 'requested_changes';
  findings: Finding[];
  summary: string;
  breakGlass: boolean;
  tier: string;
  specialistCount: number;
  cost: { tokens: number; usd: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const picker = $('picker');
const runBtn = $<HTMLButtonElement>('run');
const breakGlass = $<HTMLInputElement>('breakglass');
const traceEl = $('trace');
const findingsEl = $('findings');
const verdictCard = $('verdict');
const errorBox = $('error');

let selected = 'lite';

picker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.batch') as HTMLButtonElement | null;
  if (!btn) return;
  selected = btn.dataset.batch!;
  picker.querySelectorAll('.batch').forEach((b) =>
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'),
  );
});

function reset() {
  traceEl.innerHTML = '';
  findingsEl.innerHTML = '';
  verdictCard.hidden = true;
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function lane(label: string): HTMLElement {
  let el = traceEl.querySelector<HTMLElement>(`.lane[data-label="${label}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'lane';
    el.dataset.label = label;
    el.innerHTML = `<span class="dot"></span><span class="label">${label}</span><span class="stat"></span>`;
    traceEl.appendChild(el);
  }
  return el;
}

function renderFindings(findings: Finding[]) {
  findingsEl.innerHTML = '';
  for (const f of findings) {
    const el = document.createElement('div');
    el.className = 'finding';
    el.dataset.sev = f.severity;
    el.innerHTML =
      `<div class="top"><span class="sev">${f.severity}</span>` +
      `<span class="rid">${f.recordType} ${f.recordId}</span></div>` +
      `<div class="claim"></div><div class="evidence"></div>`;
    el.querySelector('.claim')!.textContent = f.claim;
    el.querySelector('.evidence')!.textContent = f.evidence;
    findingsEl.appendChild(el);
  }
}

function renderVerdict(result: RunResult) {
  const badge = $('verdict-badge');
  badge.dataset.v = result.verdict;
  badge.textContent = result.verdict.replace(/_/g, ' ') + (result.breakGlass ? ' (break glass)' : '');
  $('summary').textContent = result.summary || '';
  renderFindings(result.findings);

  const savings = HUMAN_BASELINE_USD > 0 ? Math.round((1 - result.cost.usd / HUMAN_BASELINE_USD) * 100) : 0;
  $('ledger').innerHTML = [
    cell('Cost this run', fmtUsd(result.cost.usd), `${result.cost.tokens.toLocaleString()} tokens`),
    cell('Vs. analyst review', `$${HUMAN_BASELINE_USD}`, `~${savings}% cheaper`),
    cell('Team', `${result.specialistCount} agents`, `${result.tier} tier`),
    cell('Findings', `${result.findings.length}`, 'deduped + filtered'),
  ].join('');
  verdictCard.hidden = false;
}

function cell(k: string, v: string, sub: string): string {
  return `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`;
}

function handle(event: any) {
  switch (event.type) {
    case 'served': {
      const s = $('served');
      s.textContent =
        event.servedAs === 'fresh'
          ? 'fresh run'
          : event.servedAs === 'cached'
            ? `cached real run · ${Math.round((event.cacheHitRate || 0) * 100)}% hit rate`
            : `failback — ${event.reason}`;
      break;
    }
    case 'agent_start':
      lane(event.label).dataset.state = 'running';
      break;
    case 'agent_done': {
      const el = lane(event.label);
      el.dataset.state = 'done';
      el.querySelector('.stat')!.textContent =
        `${event.findingCount} finding(s)${event.failedBack ? ' · failed back' : ''}`;
      break;
    }
    case 'agent_error': {
      const el = lane(event.label);
      el.dataset.state = 'error';
      el.querySelector('.stat')!.textContent = 'unavailable';
      break;
    }
    case 'verdict':
      renderVerdict(event.result as RunResult);
      break;
    case 'fatal':
      showError(event.message || 'Run failed.');
      break;
  }
}

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

async function run() {
  reset();
  runBtn.disabled = true;
  runBtn.textContent = 'Reviewing…';
  try {
    const resp = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: selected, breakGlass: breakGlass.checked }),
    });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({ error: `Request failed (${resp.status}).` }));
      showError(data.error || `Request failed (${resp.status}).`);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e) {
    showError(String((e as Error)?.message ?? e));
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Run review';
  }
}

runBtn.addEventListener('click', run);
