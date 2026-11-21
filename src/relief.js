// Government relief programs a tariff-hit Ontario business MAY qualify for.
// These are pointers, not eligibility decisions: each card tells the client to confirm the program's criteria.
// Sources: ontario.ca Protect Ontario Financing Program page; FedDev Ontario RTRI page; Finance Canada remission
// process page; City of Waterloo trade and tariff resources (BDC Pivot to Grow); Ontario Together Trade Fund coverage.

export function reliefPrograms(profile, totals, surtaxTotal) {
  const { region = 'southern-ontario', employees = 10, sector = 'retail' } = profile;
  const ontario = region !== 'other';
  const sme = employees < 500;
  const out = [];

  if (ontario) {
    out.push({
      id: 'pofp', name: 'Protect Ontario Financing Program', type: 'Loan (working capital)',
      fit: 'Ontario businesses facing tariff-related working-capital pressure (payroll, leases, utilities).',
      why: `You paid ${money(surtaxTotal)} in surtax on these documents, which squeezes cash for payroll and rent.`,
      link: 'https://ontario.ca/page/protect-ontario-financing-program',
    });
  }
  if (region === 'southern-ontario' && sme) {
    out.push({
      id: 'rtri', name: 'Regional Tariff Response Initiative (FedDev Ontario)', type: 'Federal support for SMEs',
      fit: 'Southern Ontario small and medium-sized businesses adapting to tariff disruptions.',
      why: 'Your surtax costs and sourcing changes are the kind of impact the program asks applicants to show.',
      link: 'https://feddev-ontario.canada.ca/en/node/549',
    });
  }
  if (ontario && sme) {
    out.push({
      id: 'ottf', name: 'Ontario Together Trade Fund', type: 'Grant or loan',
      fit: 'Small and medium-sized businesses reducing reliance on U.S. suppliers and markets.',
      why: totals.avoidablePerOrder > 0 ? `Switching suppliers could avoid about ${money(totals.avoidablePerOrder)} per order.` : 'Supports diversifying away from U.S. suppliers.',
      link: '',
    });
  }
  if (sector === 'manufacturing' || surtaxTotal >= 10000) {
    out.push({
      id: 'remission', name: 'U.S. surtax remission (Department of Finance)', type: 'Tariff relief or refund',
      fit: 'Businesses facing exceptional harm or unable to source critical U.S. inputs elsewhere. The bar is high.',
      why: 'Your broker can file this alongside the refund claims if you rely on U.S. inputs with no substitute.',
      link: 'https://www.canada.ca/en/department-finance/programs/international-trade-finance-policy/process-requesting-remission-tariffs-that-apply-on-certain-goods-us',
    });
  }
  if (sector === 'manufacturing' || sector === 'wholesale') {
    out.push({
      id: 'bdc', name: 'BDC Pivot to Grow (liquidity stream)', type: 'Loan, $250K to $5M',
      fit: 'Larger cash-flow needs caused by the latest U.S. tariffs.',
      why: 'Only worth it if your cash gap is in the hundreds of thousands.',
      link: 'https://www.bdc.ca',
    });
  }
  return out;
}

const money = (n) => n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
