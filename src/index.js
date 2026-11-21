import { WorkflowEntrypoint } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';
import { TARIFFS, TARIFF_LIST_VERSION, RATE_BY_CODE, tariffText } from './tariffs.js';
import { buildFindings, summarize, parseTable, normalizeLine, normCountry } from './rules.js';
import { reliefPrograms } from './relief.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const mock = (env) => env.MOCK_AI === '1';

// Every AI call can go through AI Gateway, which logs each request/response: the audit trail
// a licensed broker needs to see why the AI classified something the way it did.
function runAI(env, model, input) {
  const opts = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
  return env.AI.run(model, input, opts);
}

function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// ---------- 1. Read the document (privately: the AI runs on Cloudflare, files stay in R2) ----------
async function documentText(env, file, pasted, trace) {
  if (pasted && pasted.trim()) return pasted;
  if (!file) throw new Error('Upload a file or paste invoice text.');
  const name = file.name || 'upload';
  if (/\.(txt|csv|md)$/i.test(name) || (file.type || '').startsWith('text/')) return await file.text();
  const res = await env.AI.toMarkdown([{ name, blob: new Blob([await file.arrayBuffer()], { type: file.type || 'application/pdf' }) }]);
  trace.push('Workers AI · converted the PDF to text on Cloudflare');
  const first = Array.isArray(res) ? res[0] : res;
  return first?.data || '';
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' }, supplier: { type: 'string' }, quantity: { type: 'number' },
          value: { type: 'number' }, origin: { type: 'string' }, shippedFrom: { type: 'string' },
          hsDeclared: { type: 'string' }, surtaxPaid: { type: 'number' },
        },
        required: ['description'],
      },
    },
  },
  required: ['lines'],
};

const EXTRACT_PROMPT = `You extract line items from Canadian import documents (commercial invoices, customs entries).
Return JSON {"lines":[...]} with one object per product line:
description, supplier, quantity, value (CAD number), origin (country where the goods were MADE, as written; empty string if not stated),
shippedFrom (country shipped from), hsDeclared (tariff/HS code as written), surtaxPaid (CAD surtax or counter-tariff paid; 0 if none).
Never guess an origin that is not on the document. Numbers only, no currency symbols.`;

async function extractLines(env, text, trace) {
  const table = parseTable(text);
  if (mock(env) && table.length) {
    trace.push('Mock mode · read the pipe table without AI (saves neurons while building)');
    return table;
  }
  try {
    const out = await runAI(env, env.MODEL || DEFAULT_MODEL, {
      messages: [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: text.slice(0, 12000) }],
      response_format: { type: 'json_schema', json_schema: EXTRACT_SCHEMA },
      max_tokens: 2048,
    });
    const obj = parseJson(out?.response ?? out);
    const lines = (obj?.lines || []).map(normalizeLine).filter((l) => l.description);
    if (lines.length) {
      trace.push(`Workers AI · extracted ${lines.length} line items from the document`);
      return lines;
    }
  } catch (e) {
    trace.push(`Workers AI extraction failed (${String(e.message).slice(0, 80)}); using the table reader`);
  }
  if (table.length) return table;
  throw new Error('Could not read any line items. Try pasting the invoice table as text.');
}

// ---------- 2. Classify by meaning (Vectorize), so "30in ombre braid" finds the right tariff heading ----------
let memIndex = null;
async function embed(env, texts) {
  const r = await runAI(env, EMBED_MODEL, { text: texts });
  return r.data;
}
const cosine = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x) * Math.sqrt(y) || 1);
};
function keywordMatch(desc) {
  const d = desc.toLowerCase();
  const scored = TARIFFS.map((t) => ({ code: t.code, description: t.description, score: t.keywords.filter((k) => d.includes(k)).length }))
    .sort((p, q) => q.score - p.score);
  return scored.slice(0, 3).map((s) => ({ ...s, score: s.score ? Math.min(0.95, 0.6 + 0.15 * s.score) : 0 }));
}

async function classify(env, lines, trace) {
  if (mock(env)) {
    trace.push('Mock mode · keyword classification');
    return lines.map((l) => { const c = keywordMatch(l.description); return { ...l, hsSuggested: c[0]?.score ? c[0].code : '', hsScore: c[0]?.score || 0, hsCandidates: c }; });
  }
  const vecs = await embed(env, lines.map((l) => `${l.description} ${l.supplier}`));
  let usedVectorize = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let matches = [];
    if (env.VECTORIZE) {
      try {
        const r = await env.VECTORIZE.query(vecs[i], { topK: 3, returnMetadata: 'all' });
        matches = (r.matches || []).map((m) => ({ code: m.id, score: m.score, description: m.metadata?.description || '' }));
        usedVectorize = matches.length > 0;
      } catch { /* index not seeded yet: fall back below */ }
    }
    if (!matches.length) {
      if (!memIndex) {
        const tv = await embed(env, TARIFFS.map(tariffText));
        memIndex = TARIFFS.map((t, j) => ({ code: t.code, description: t.description, vec: tv[j] }));
      }
      matches = memIndex.map((t) => ({ code: t.code, description: t.description, score: cosine(vecs[i], t.vec) }))
        .sort((p, q) => q.score - p.score).slice(0, 3);
    }
    out.push({ ...lines[i], hsSuggested: matches[0]?.code || '', hsScore: matches[0]?.score || 0, hsCandidates: matches });
  }
  trace.push(usedVectorize ? `Vectorize · matched ${lines.length} items to tariff headings by meaning` : `Workers AI embeddings · matched ${lines.length} items by meaning (seed Vectorize to use the index)`);
  return out;
}

// ---------- 3. Scan endpoint: read → classify → rules → save ----------
async function handleScan(req, env) {
  const trace = [];
  const form = await req.formData();
  const file = form.get('file');
  const pasted = form.get('text') || '';
  const client = String(form.get('client') || 'Demo client');
  const exportShare = Math.min(1, Math.max(0, Number(form.get('exportShare') || 0) / 100));
  const profile = {
    sector: String(form.get('sector') || 'retail'),
    employees: Number(form.get('employees') || 10),
    region: String(form.get('region') || 'southern-ontario'),
  };
  const scanId = uid('scan');

  if (file && typeof file !== 'string' && env.DOCS) {
    await env.DOCS.put(`uploads/${scanId}/${file.name}`, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    trace.push('R2 · stored the original document privately');
  }
  const text = await documentText(env, typeof file === 'string' ? null : file, String(pasted), trace);
  const lines = await classify(env, await extractLines(env, text, trace), trace);
  const findings = buildFindings(lines, { rates: RATE_BY_CODE, exportShare });
  const totals = summarize(findings);
  trace.push(`Rules engine · checked ${lines.length} lines against origin, classification, drawback and sourcing rules`);

  if (env.DB) {
    await env.DB.prepare('INSERT INTO scans (id, client, created_at, export_share, lines, findings, recoverable) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(scanId, client, new Date().toISOString(), exportShare, JSON.stringify(lines), JSON.stringify(findings), totals.recoverable).run();
    trace.push('D1 · saved the scan for monitoring');
    await addLedger(env, { client, payer: 'client', stream: 'setup', amount: PRICES.setup, ref: scanId });
    trace.push('Ledger · $1,500 setup fee recorded');
  }
  const surtaxTotal = lines.reduce((s, l) => s + (l.surtaxPaid || 0), 0);
  const programs = reliefPrograms(profile, totals, surtaxTotal);
  trace.push(`Relief matcher · found ${programs.length} government programs worth checking`);
  return json({ scanId, client, profile, lines, findings, totals, surtaxTotal, programs, tariffList: TARIFF_LIST_VERSION, demoRates: true, trace });
}

// ---------- Origin Detective: when the invoice doesn't say where a product was made, go find the proof ----------
const ORIGIN_PROMPT = `You read a supplier's product web page and find where the product was MADE (country of origin).
Return JSON {"origin": country name or "" if the page does not say, "evidence": the exact sentence from the page that states it, or ""}.
Do not guess. "Ships from" or "warehouse" is not the country of origin.`;

// Keep one line per table cell / paragraph so "Country of origin" and its value stay separable.
const pageText = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(td|th|tr|p|li|div|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();

async function readPage(req, env, url, trace) {
  // 1. Browser Rendering: a real headless browser on Cloudflare, so we also capture a screenshot as evidence.
  if (env.BROWSER) {
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      const text = await page.evaluate(() => document.body.innerText);
      const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
      trace.push('Browser Rendering · opened the supplier page and took a screenshot as evidence');
      return { text, screenshot: `data:image/jpeg;base64,${Buffer.from(shot).toString('base64')}` };
    } catch (e) {
      trace.push(`Browser Rendering unavailable (${String(e.message).split('\n')[0].slice(0, 80)}); reading the page directly`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  // 2. Fallback: read the page HTML (our own demo pages come straight from static assets).
  const own = new URL(url).origin === new URL(req.url).origin;
  const res = own && env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url, { headers: { 'user-agent': 'Tariff Trace AI origin check' } });
  trace.push('Worker · read the supplier page text');
  return { text: pageText(await res.text()), screenshot: null };
}

async function handleOrigin(req, env) {
  const { url, finding, line } = await req.json();
  if (!url || !finding) return json({ error: 'url and finding required' }, 400);
  const trace = [];
  const { text, screenshot } = await readPage(req, env, url, trace);
  let origin = '', evidence = '';
  if (!mock(env)) {
    try {
      const out = await runAI(env, env.MODEL || DEFAULT_MODEL, {
        messages: [{ role: 'system', content: ORIGIN_PROMPT }, { role: 'user', content: `Product: ${line?.description || ''}\n\nPage text:\n${text.slice(0, 8000)}` }],
        response_format: { type: 'json_object' }, max_tokens: 300,
      });
      const o = parseJson(out?.response ?? out) || {};
      origin = o.origin || ''; evidence = o.evidence || '';
      trace.push('Workers AI · read the page and found the origin statement');
    } catch (e) { trace.push(`Workers AI origin check failed (${String(e.message).slice(0, 80)}); using pattern match`); }
  }
  if (!origin) {
    const m = text.match(/(?:country of origin|made in|manufactured in)\s*[:\-]?\s*([A-Za-z .]+?)(?:[.\n,;|]|$)/i);
    if (m) { origin = m[1].trim(); evidence = m[0].trim(); }
  }
  const code = normCountry(origin);
  let updated = finding;
  if (code && code !== 'US') {
    updated = {
      ...finding, type: 'non_us_origin', kind: 'refund', confidence: 'high',
      title: `Origin found: made in ${origin}, not the U.S.`,
      why: `The supplier's own product page says "${evidence}". Counter-tariffs apply only to U.S.-origin goods, so this surtax is refundable.`,
      docs: ['Screenshot of supplier product page', 'Supplier statement of origin (confirm)'],
    };
  } else if (code === 'US') {
    updated = { ...finding, kind: 'avoidable', type: 'future_avoidance', title: 'Confirmed U.S.-made: avoid on your next order', why: `The supplier page says "${evidence}". The surtax applies; consider a non-U.S. supplier.` };
  }
  return json({ origin, code, evidence, screenshot, finding: updated, trace });
}

// ---------- Relief application helper: turn the scan into the "tariff impact" summary applications ask for ----------
async function handleReliefDraft(req, env) {
  const { client, profile, program, totals, surtaxTotal, lines = [] } = await req.json();
  const top = [...lines].sort((a, b) => b.surtaxPaid - a.surtaxPaid).slice(0, 3).map((l) => `${l.description} (${l.surtaxPaid.toFixed(0)} CAD surtax)`);
  const facts = { client, sector: profile?.sector, employees: profile?.employees, program: program?.name, surtaxPaid: surtaxTotal, recoverable: totals?.recoverable, avoidablePerOrder: totals?.avoidablePerOrder, topItems: top };
  let summary;
  if (mock(env)) {
    summary = `${client} (${profile?.sector}, ${profile?.employees} employees) paid ${Math.round(surtaxTotal)} CAD in counter-tariff surtax on recent U.S. imports, led by ${top.join('; ')}. About ${Math.round(totals?.avoidablePerOrder || 0)} CAD per order remains exposed until suppliers are switched. We are applying to ${program?.name} to [to confirm: purpose, e.g. cover working capital / diversify suppliers].`;
  } else {
    const out = await runAI(env, env.MODEL || DEFAULT_MODEL, {
      messages: [
        { role: 'system', content: 'Write a short, factual "tariff impact" paragraph (under 120 words) for a Canadian small business applying to a government tariff relief program. Use only the facts given. Write [to confirm] for anything missing. No promises of eligibility.' },
        { role: 'user', content: JSON.stringify(facts) },
      ],
      max_tokens: 400,
    });
    summary = String(out?.response || '').trim();
  }
  await addLedger(env, { client, payer: 'client', stream: 'relief_prep', amount: PRICES.relief_prep, ref: program?.id || '' });
  return json({ summary, trace: [mock(env) ? 'Mock mode · template summary' : 'Workers AI · drafted the tariff impact summary from the scan', 'Ledger · $500 relief application prep fee recorded'] });
}

// ---------- 4. Claim drafting (AI writes; broker approves) ----------
const DRAFT_PROMPT = `You prepare DRAFT customs relief paperwork for a licensed Canadian customs broker to review.
Use only the facts given. Do not invent dates, entry numbers or legal citations; write [to confirm] where something is missing.
Return JSON {"claimSummary": string (plain-language claim explanation, 120 words max),
"brokerChecklist": string[] (documents and checks the broker must complete),
"supplierEmail": string (short email to the supplier requesting any missing document, or "" if none needed)}.`;

async function handleDraft(req, env) {
  const { client = 'Demo client', finding, line } = await req.json();
  if (!finding) return json({ error: 'finding required' }, 400);
  let draft;
  if (mock(env)) {
    draft = {
      claimSummary: `${client} paid ${finding.amount.toFixed(2)} CAD in surtax on line ${finding.line} (${line?.description || 'item'}). ${finding.why} We request relief of ${finding.amount.toFixed(2)} CAD. [to confirm: entry number and release date]`,
      brokerChecklist: finding.docs,
      supplierEmail: finding.type === 'origin_unknown' || finding.type === 'non_us_origin'
        ? `Hi ${line?.supplier || 'team'}, could you send a statement confirming the country of origin (where it was manufactured) for "${line?.description}"? We need it for a customs refund. Thank you!` : '',
    };
  } else {
    const out = await runAI(env, env.MODEL || DEFAULT_MODEL, {
      messages: [{ role: 'system', content: DRAFT_PROMPT }, { role: 'user', content: JSON.stringify({ client, finding, line }) }],
      response_format: { type: 'json_object' },
      max_tokens: 900,
    });
    draft = parseJson(out?.response ?? out) || { claimSummary: String(out?.response || ''), brokerChecklist: finding.docs, supplierEmail: '' };
  }
  return json({ draft, trace: [mock(env) ? 'Mock mode · template draft' : 'Workers AI · drafted the claim and supplier email'] });
}

async function handleSend(req, env) {
  const { scanId = '', client = 'Demo client', finding, draft } = await req.json();
  if (!finding) return json({ error: 'finding required' }, 400);
  const claimId = uid('claim');
  if (!env.DB || !env.CLAIM_WORKFLOW) return json({ claimId, status: 'Drafted', note: 'Add the D1 and Workflows bindings to track claims.', trace: [] });
  const history = [{ status: 'Drafted', at: new Date().toISOString() }];
  await env.DB.prepare('INSERT INTO claims (id, scan_id, client, finding, draft, amount, status, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(claimId, scanId, client, JSON.stringify(finding), JSON.stringify(draft || {}), finding.amount, 'Drafted', JSON.stringify(history)).run();
  await env.CLAIM_WORKFLOW.create({
    id: claimId,
    params: { claimId, client, amount: finding.amount, refundDelay: env.REFUND_DELAY || '20 seconds' },
  });
  return json({ claimId, status: 'Drafted', trace: ['D1 · saved the claim', 'Workflows · claim is waiting in the broker portal for a licensed broker to file'] });
}

async function handleClaimStatus(env, id) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 400);
  const row = await env.DB.prepare('SELECT id, status, history, amount, fee FROM claims WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json({ ...row, history: JSON.parse(row.history || '[]') });
}

// ---------- Billing ledger: every revenue stream from the business plan, recorded as it's earned ----------
const PRICES = { setup: 1500, relief_prep: 500, prepared_claim: 250, platform_licence: 1000, monitoring: 299, fee_rate: 0.2 };
async function addLedger(env, { client, payer, stream, amount, ref = '' }) {
  if (!env.DB || !(amount > 0)) return;
  await env.DB.prepare('INSERT INTO ledger (id, created_at, client, payer, stream, amount, ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(uid('led'), new Date().toISOString(), client, payer, stream, Math.round(amount * 100) / 100, ref).run();
}

async function handleBrokerQueue(env) {
  if (!env.DB) return json({ claims: [] });
  const { results } = await env.DB.prepare("SELECT id, client, finding, draft, amount, status, history FROM claims WHERE status IN ('Broker reviewing', 'Filed', 'Refund received', 'Needs follow-up') ORDER BY rowid DESC LIMIT 50").all();
  return json({ claims: (results || []).map((r) => ({ ...r, finding: JSON.parse(r.finding || '{}'), draft: JSON.parse(r.draft || '{}'), history: JSON.parse(r.history || '[]') })) });
}

async function handleBrokerFile(env, id) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 400);
  const row = await env.DB.prepare('SELECT client, status FROM claims WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'Broker reviewing') return json({ error: `claim is ${row.status}` }, 409);
  await setStatus(env, id, 'Filed', { by: 'licensed broker' });
  await addLedger(env, { client: row.client, payer: 'broker', stream: 'prepared_claim', amount: PRICES.prepared_claim, ref: id });
  return json({ ok: true, status: 'Filed', trace: ['D1 · broker approval recorded; $250 prepared-claim fee added to the ledger', 'Workflows · claim resumes: waiting for the refund'] });
}

// Runs each month (button in the admin dashboard for the demo): monitoring subscriptions + 20% of surtax avoided.
async function handleMonthlyBilling(env) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 400);
  const { results } = await env.DB.prepare('SELECT id, client, findings FROM scans').all();
  let count = 0;
  for (const s of results || []) {
    const avoidable = summarize(JSON.parse(s.findings || '[]')).avoidablePerOrder;
    await addLedger(env, { client: s.client, payer: 'client', stream: 'monitoring', amount: PRICES.monitoring, ref: s.id });
    await addLedger(env, { client: s.client, payer: 'client', stream: 'savings_fee', amount: avoidable * PRICES.fee_rate, ref: s.id });
    count++;
  }
  const brokers = Number(env.BROKER_LICENCES || 1);
  for (let b = 0; b < brokers; b++) await addLedger(env, { client: `Broker firm ${b + 1}`, payer: 'broker', stream: 'platform_licence', amount: PRICES.platform_licence, ref: 'licence' });
  return json({ billedClients: count, brokerLicences: brokers });
}

async function handleAdmin(env) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 400);
  const q = async (sql) => (await env.DB.prepare(sql).all()).results || [];
  const [streams, statuses, clients, recent, pipeline] = await Promise.all([
    q('SELECT stream, payer, SUM(amount) AS total, COUNT(*) AS n FROM ledger GROUP BY stream, payer'),
    q('SELECT status, COUNT(*) AS n, SUM(amount) AS amount FROM claims GROUP BY status'),
    q('SELECT COUNT(DISTINCT client) AS n, SUM(recoverable) AS recoverable FROM scans'),
    q('SELECT created_at, client, payer, stream, amount FROM ledger ORDER BY created_at DESC LIMIT 15'),
    q("SELECT SUM(amount) AS open FROM claims WHERE status IN ('Drafted', 'Broker reviewing', 'Filed')"),
  ]);
  return json({ streams, statuses, clients: clients[0] || {}, recent, pendingSuccessFees: Math.round((pipeline[0]?.open || 0) * PRICES.fee_rate * 100) / 100, prices: PRICES });
}

async function setStatus(env, claimId, status, extra = {}) {
  const row = await env.DB.prepare('SELECT history FROM claims WHERE id = ?').bind(claimId).first();
  const history = JSON.parse(row?.history || '[]');
  history.push({ status, at: new Date().toISOString(), ...extra });
  await env.DB.prepare('UPDATE claims SET status = ?, history = ?, fee = COALESCE(?, fee) WHERE id = ?')
    .bind(status, JSON.stringify(history), extra.fee ?? null, claimId).run();
}

// Claims take weeks to months in real life. A Workflow pauses between steps and survives restarts,
// so each claim is a durable process that ends by billing our 20% success fee. Delays are short for the demo.
export class ClaimWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { claimId, amount, client, refundDelay } = event.payload;
    await step.do('send to licensed broker', async () => setStatus(this.env, claimId, 'Broker reviewing'));
    // Human in the loop: the claim waits in the broker portal until a licensed broker approves and files it.
    let filed = false;
    for (let i = 0; i < 240 && !filed; i++) {
      await step.sleep(`wait for broker ${i}`, '15 seconds');
      filed = await step.do(`check broker ${i}`, async () => {
        const row = await this.env.DB.prepare('SELECT status FROM claims WHERE id = ?').bind(claimId).first();
        return row?.status === 'Filed';
      });
    }
    if (!filed) {
      await step.do('broker timeout', async () => setStatus(this.env, claimId, 'Needs follow-up'));
      return { claimId, filed: false };
    }
    // Real life: weeks to months. Demo: seconds.
    await step.sleep('wait for refund', refundDelay);
    const fee = await step.do('refund received, bill success fee', async () => {
      const f = Math.round(amount * 0.2 * 100) / 100;
      await setStatus(this.env, claimId, 'Refund received', { fee: f });
      await addLedger(this.env, { client, payer: 'client', stream: 'refund_success', amount: f, ref: claimId });
      return f;
    });
    return { claimId, amount, fee };
  }
}

// ---------- 5. Monitoring: when the tariff list changes, re-check every saved client ----------
async function recheckAll(env, rates, reason) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare('SELECT id, client, lines, findings, export_share FROM scans').all();
  const alerts = [];
  for (const s of results || []) {
    const lines = JSON.parse(s.lines);
    const before = summarize(JSON.parse(s.findings));
    const after = summarize(buildFindings(lines, { rates, exportShare: s.export_share || 0 }));
    const hit = lines.filter((l) => l.origin === 'US' && (rates[l.hsSuggested || l.hsDeclared] || 0) > (RATE_BY_CODE[l.hsSuggested || l.hsDeclared] || 0));
    if (hit.length || after.avoidablePerOrder !== before.avoidablePerOrder) {
      const message = `${reason}: ${hit.length ? hit.map((l) => l.description).join(', ') + (hit.length === 1 ? ' now carries surtax. ' : ' now carry surtax. ') : ''}Set up relief or switch suppliers before your next order.`;
      const id = uid('alert');
      await env.DB.prepare('INSERT INTO alerts (id, created_at, scan_id, client, message) VALUES (?, ?, ?, ?, ?)').bind(id, new Date().toISOString(), s.id, s.client, message).run();
      alerts.push({ id, client: s.client, message });
    }
  }
  return alerts;
}

async function handleSimulateUpdate(env) {
  // Demo: Ottawa adds hair dryers to the list overnight.
  const rates = { ...RATE_BY_CODE, '8516.31': 0.25 };
  const alerts = await recheckAll(env, rates, 'Tariff list updated (hair dryers 8516.31 added at 25%, demo)');
  return json({ alerts, trace: ['Cron/Queues in production · re-checked every saved client against the new list', 'D1 · stored alerts'] });
}

async function handleSeed(env) {
  if (!env.VECTORIZE) return json({ error: 'Vectorize not bound' }, 400);
  const vecs = await embed(env, TARIFFS.map(tariffText));
  await env.VECTORIZE.upsert(TARIFFS.map((t, i) => ({ id: t.code, values: vecs[i], metadata: { description: t.description, rate: t.rate } })));
  return json({ seeded: TARIFFS.length });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname === '/api/scan') return await handleScan(req, env);
      if (req.method === 'POST' && url.pathname === '/api/claim/draft') return await handleDraft(req, env);
      if (req.method === 'POST' && url.pathname === '/api/claim/send') return await handleSend(req, env);
      if (req.method === 'POST' && url.pathname === '/api/origin') return await handleOrigin(req, env);
      if (req.method === 'GET' && url.pathname === '/api/broker/claims') return await handleBrokerQueue(env);
      if (req.method === 'POST' && /^\/api\/broker\/claims\/[^/]+\/file$/.test(url.pathname)) return await handleBrokerFile(env, url.pathname.split('/').at(-2));
      if (req.method === 'POST' && url.pathname === '/api/billing/run-monthly') return await handleMonthlyBilling(env);
      if (req.method === 'GET' && url.pathname === '/api/admin/summary') return await handleAdmin(env);
      if (req.method === 'POST' && url.pathname === '/api/relief/draft') return await handleReliefDraft(req, env);
      if (req.method === 'GET' && url.pathname.startsWith('/api/claim/')) return await handleClaimStatus(env, url.pathname.split('/').pop());
      if (req.method === 'POST' && url.pathname === '/api/tariffs/simulate-update') return await handleSimulateUpdate(env);
      if (req.method === 'GET' && url.pathname === '/api/alerts') {
        if (!env.DB) return json({ alerts: [] });
        const { results } = await env.DB.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20').all();
        return json({ alerts: results || [] });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/seed') return await handleSeed(env);
      if (url.pathname === '/api/health') return json({ ok: true, mock: mock(env), bindings: { ai: !!env.AI, db: !!env.DB, r2: !!env.DOCS, vectorize: !!env.VECTORIZE, workflow: !!env.CLAIM_WORKFLOW, browser: !!env.BROWSER, gateway: !!env.AI_GATEWAY_ID } });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  // Runs on a schedule (wrangler.jsonc "triggers"). In production this fetches the published list and
  // re-checks every client; here it re-runs the current list so the pipeline is exercised.
  async scheduled(_event, env) {
    await recheckAll(env, RATE_BY_CODE, 'Scheduled tariff re-check');
  },
};
