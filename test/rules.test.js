import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTable, buildFindings, summarize } from '../src/rules.js';
import { TARIFFS, RATE_BY_CODE } from '../src/tariffs.js';

// Pull the two sample invoices out of the frontend so the test checks exactly what the demo uses.
const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const samples = [...html.matchAll(/text: `([\s\S]*?)` \}/g)].map((m) => m[1]);
assert.equal(samples.length, 2, 'found both samples');

const kw = (desc) => {
  const d = desc.toLowerCase();
  return TARIFFS.map((t) => ({ code: t.code, s: t.keywords.filter((k) => d.includes(k)).length })).sort((a, b) => b.s - a.s)[0];
};
const run = (text, exportShare) => {
  const lines = parseTable(text).map((l) => { const m = kw(l.description); return { ...l, hsSuggested: m.s ? m.code : '', hsScore: 0.8 }; });
  const findings = buildFindings(lines, { rates: RATE_BY_CODE, exportShare });
  return { lines, findings, totals: summarize(findings) };
};

const beauty = run(samples[1], 0);
assert.equal(beauty.lines.length, 7);
console.log('BEAUTY lines', beauty.lines.map((l) => [l.line, l.origin || '?', l.hsDeclared, l.hsSuggested, l.surtaxPaid].join(' ')));
console.log('BEAUTY findings', beauty.findings.map((f) => `${f.id} ${f.kind} ${f.amount}`));
console.log('BEAUTY totals', beauty.totals);
assert.equal(beauty.totals.recoverable, 1575);
assert.equal(beauty.totals.pending, 125);
assert.equal(beauty.totals.avoidablePerOrder, 1587.5);

const lake = run(samples[0], 0.3);
console.log('LAKESHORE findings', lake.findings.map((f) => `${f.id} ${f.kind} ${f.amount}`));
console.log('LAKESHORE totals', lake.totals);
assert.equal(lake.lines.length, 5);
assert.equal(lake.totals.recoverable, 17800);
assert.equal(lake.totals.pending, 1500);
assert.equal(lake.totals.avoidablePerOrder, 7700);
assert.ok(new Set(lake.findings.map((f) => f.type)).size === 5, 'shows all five finding types');
console.log('all tests passed');
