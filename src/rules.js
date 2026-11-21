// Tariff Trace AI rules engine: plain, deterministic dollar math on top of the AI's extraction and classification.
// The AI reads and classifies; this file decides eligibility and amounts so every number is explainable.

const COUNTRY = {
  US: 'US', USA: 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', AMERICA: 'US',
  CN: 'CN', CHINA: 'CN', PRC: 'CN',
  KR: 'KR', KOREA: 'KR', 'SOUTH KOREA': 'KR', 'REPUBLIC OF KOREA': 'KR', 'KOREA REPUBLIC OF': 'KR',
  IN: 'IN', INDIA: 'IN', ID: 'ID', INDONESIA: 'ID', VN: 'VN', VIETNAM: 'VN', 'VIET NAM': 'VN',
  MX: 'MX', MEXICO: 'MX', CA: 'CA', CANADA: 'CA', JP: 'JP', JAPAN: 'JP', TW: 'TW', TAIWAN: 'TW',
  FR: 'FR', FRANCE: 'FR', IT: 'IT', ITALY: 'IT', DE: 'DE', GERMANY: 'DE', TH: 'TH', THAILAND: 'TH',
};

export function normCountry(v) {
  if (!v) return '';
  const k = String(v).trim().toUpperCase().replace(/\./g, '');
  if (COUNTRY[k]) return COUNTRY[k];
  if (k.length === 2) return k;
  // Longer phrases ("Republic of Korea, ships from NY"): find a country name inside, longest first.
  const hit = Object.keys(COUNTRY).filter((n) => n.length > 3).sort((a, b) => b.length - a.length).find((n) => new RegExp(`\\b${n}\\b`).test(k));
  return hit ? COUNTRY[hit] : '';
}

export function normCode(v) {
  if (!v) return '';
  const d = String(v).replace(/[^0-9]/g, '');
  if (d.length < 6) return '';
  return `${d.slice(0, 4)}.${d.slice(4, 6)}`;
}

export function num(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function normalizeLine(l, i) {
  return {
    line: l.line || i + 1,
    description: String(l.description || '').trim(),
    supplier: String(l.supplier || '').trim(),
    quantity: num(l.quantity),
    value: num(l.value),
    origin: normCountry(l.origin),
    shippedFrom: normCountry(l.shippedFrom),
    hsDeclared: normCode(l.hsDeclared),
    surtaxPaid: num(l.surtaxPaid),
  };
}

const money = (n) => Math.round(n * 100) / 100;

// rates: map code -> surtax rate (demo list). exportShare: 0..1 of goods (or goods made from them) exported.
export function buildFindings(lines, { rates, exportShare = 0 }) {
  const findings = [];
  for (const l of lines) {
    if (!(l.surtaxPaid > 0)) continue;
    const declaredRate = rates[l.hsDeclared] ?? null;
    const suggestedRate = l.hsSuggested ? rates[l.hsSuggested] ?? null : null;
    let remaining = l.surtaxPaid;

    // 1. Surtax only applies to U.S.-origin goods. Origin = where it was made, not where it shipped from.
    if (l.origin && l.origin !== 'US') {
      findings.push({
        id: `L${l.line}-origin`, line: l.line, type: 'non_us_origin', kind: 'refund',
        title: 'Charged U.S. surtax on goods not made in the U.S.',
        amount: money(remaining), confidence: 'high',
        why: `Invoice shows country of origin ${l.origin}${l.shippedFrom === 'US' ? ', shipped from a U.S. warehouse' : ''}. Counter-tariffs apply only to U.S.-origin goods.`,
        docs: ['Commercial invoice showing origin', 'Supplier certificate or statement of origin'],
      });
      continue;
    }

    // 2. Origin missing: can't claim yet, but likely recoverable once the supplier confirms origin.
    if (!l.origin) {
      findings.push({
        id: `L${l.line}-origin-unknown`, line: l.line, type: 'origin_unknown', kind: 'pending',
        title: 'Origin not stated: request it from the supplier',
        amount: money(remaining), confidence: 'medium',
        why: 'No country of origin on the invoice. If the supplier confirms it was made outside the U.S., the surtax is refundable.',
        docs: ['Supplier statement of origin'],
      });
      continue;
    }

    // 3. Possible misclassification: AI-suggested code carries a lower surtax rate than the declared code.
    if (l.hsSuggested && l.hsDeclared && l.hsSuggested !== l.hsDeclared && declaredRate != null && suggestedRate != null && suggestedRate < declaredRate) {
      const correct = l.value * suggestedRate;
      const over = Math.max(0, remaining - correct);
      if (over > 0) {
        findings.push({
          id: `L${l.line}-class`, line: l.line, type: 'misclassified', kind: 'refund',
          title: `Possibly wrong tariff code (${l.hsDeclared} → ${l.hsSuggested})`,
          amount: money(over), confidence: (l.hsScore ?? 0) >= 0.75 ? 'medium' : 'low',
          why: `Description "${l.description}" matches ${l.hsSuggested} more closely, which carries a lower surtax rate. Broker to confirm the classification.`,
          docs: ['Product spec sheet', 'Broker classification review'],
        });
        remaining = money(remaining - over);
      }
    }

    // 4. Duty drawback: surtax paid on goods later exported (or used in goods exported).
    if (exportShare > 0 && remaining > 0) {
      const amt = money(remaining * exportShare);
      findings.push({
        id: `L${l.line}-drawback`, line: l.line, type: 'drawback', kind: 'refund',
        title: `Duty drawback on the ${Math.round(exportShare * 100)}% exported`,
        amount: amt, confidence: 'medium',
        why: 'Surtax paid on goods that were later exported (or went into exported products) can be claimed back through drawback.',
        docs: ['Proof of export', 'Bill of materials or production records'],
      });
      remaining = money(remaining - amt);
    }

    // 5. Going forward: the surtax on the next order is avoidable by sourcing the same item outside the U.S.
    if (remaining > 0) {
      findings.push({
        id: `L${l.line}-future`, line: l.line, type: 'future_avoidance', kind: 'avoidable',
        title: 'Avoid this surtax on your next order',
        amount: money(remaining), confidence: 'medium',
        why: `U.S.-made, so the surtax applies. Sourcing the same item made outside the U.S. (or from a Canadian maker) avoids about this much per order.`,
        docs: ['Alternative supplier quote'],
      });
    }
  }
  return findings;
}

export function summarize(findings, feeRate = 0.2) {
  const sum = (k) => money(findings.filter((f) => f.kind === k).reduce((s, f) => s + f.amount, 0));
  const recoverable = sum('refund');
  const pending = sum('pending');
  const avoidablePerOrder = sum('avoidable');
  return {
    recoverable, pending, avoidablePerOrder,
    found: money(recoverable + pending),
    dutybackFee: money(recoverable * feeRate),
    clientKeeps: money(recoverable * (1 - feeRate)),
  };
}

// Reads a pipe table ("| Description | Supplier | ... |") straight from text. Used as a fallback
// when the AI is unavailable, and in mock mode to save Workers AI neurons while building.
export function parseTable(text) {
  const rows = String(text || '').split(/\r?\n/).filter((r) => r.includes('|'))
    .map((r) => r.split('|').map((c) => c.trim())).map((c) => (c[0] === '' ? c.slice(1) : c)).map((c) => (c.at(-1) === '' ? c.slice(0, -1) : c));
  const hi = rows.findIndex((r) => r.some((c) => /description/i.test(c)));
  if (hi < 0) return [];
  const head = rows[hi].map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ix = {
    line: col(/^line|#/), description: col(/description/), supplier: col(/supplier|vendor/), quantity: col(/qty|quantity/),
    value: col(/value|amount|price/), origin: col(/origin/), shippedFrom: col(/shipped|export/), hsDeclared: col(/hs|tariff|code/), surtaxPaid: col(/surtax/),
  };
  return rows.slice(hi + 1).filter((r) => !r.every((c) => /^-*$/.test(c)))
    .map((r, i) => normalizeLine(Object.fromEntries(Object.entries(ix).map(([k, j]) => [k, j >= 0 ? r[j] : ''])), i))
    .filter((l) => l.description);
}
