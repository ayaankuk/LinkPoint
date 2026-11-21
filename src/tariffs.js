// Seed tariff headings for the demo.
// Codes are standard HS headings; the `rate` values are DEMO ASSUMPTIONS, not the official list.
// Before real use, load Finance Canada's published counter-tariff list (HS numbers + surtax rates).
export const TARIFF_LIST_VERSION = 'demo-2026-09-08';

export const TARIFFS = [
  { code: '3304.10', rate: 0.25, description: 'Lip make-up preparations, lipstick, lip gloss', keywords: ['lip', 'lipstick', 'gloss'] },
  { code: '3304.20', rate: 0.25, description: 'Eye make-up preparations, mascara, eyeliner, eyeshadow', keywords: ['eye', 'mascara', 'liner', 'lash glue'] },
  { code: '3304.91', rate: 0.25, description: 'Make-up powders, compact or loose', keywords: ['powder', 'setting powder'] },
  { code: '3304.99', rate: 0.25, description: 'Beauty or skin-care preparations, sunscreen, moisturizer, lotion, foundation', keywords: ['sunscreen', 'spf', 'lotion', 'moisturizer', 'foundation', 'cream', 'skin'] },
  { code: '3305.10', rate: 0.25, description: 'Shampoos', keywords: ['shampoo'] },
  { code: '3305.20', rate: 0.25, description: 'Preparations for permanent waving or straightening hair, relaxers', keywords: ['relaxer', 'perm', 'straightening'] },
  { code: '3305.30', rate: 0.25, description: 'Hair lacquers, hairspray', keywords: ['hairspray', 'lacquer', 'spray'] },
  { code: '3305.90', rate: 0.25, description: 'Other hair preparations: conditioners, gels, edge control, pomade, hair oil, leave-in', keywords: ['conditioner', 'gel', 'edge', 'pomade', 'oil', 'leave-in', 'mousse'] },
  { code: '3307.20', rate: 0, description: 'Personal deodorants and antiperspirants', keywords: ['deodorant', 'antiperspirant'] },
  { code: '3401.30', rate: 0, description: 'Liquid soap and skin-washing products', keywords: ['body wash', 'liquid soap', 'cleanser'] },
  { code: '6704.11', rate: 0.25, description: 'Complete wigs of synthetic textile materials', keywords: ['wig', 'synthetic wig'] },
  { code: '6704.19', rate: 0.25, description: 'Synthetic hair braids, extensions, weaves, false eyelashes of synthetic materials', keywords: ['braid', 'braiding hair', 'extension', 'weave', 'synthetic hair', 'crochet'] },
  { code: '6704.20', rate: 0.25, description: 'Wigs, weaves and extensions of human hair', keywords: ['human hair', 'remy', 'virgin hair'] },
  { code: '9615.11', rate: 0.25, description: 'Combs and hair-slides of hard rubber or plastics', keywords: ['comb', 'detangling', 'hair slide'] },
  { code: '9615.90', rate: 0, description: 'Hairpins, curling pins, curlers, rollers', keywords: ['pin', 'bobby', 'roller', 'curler'] },
  { code: '8516.31', rate: 0, description: 'Electric hair dryers, blow dryers', keywords: ['hair dryer', 'blow dryer', 'dryer'] },
  { code: '8516.32', rate: 0.25, description: 'Other electro-thermic hairdressing apparatus: flat irons, curling irons, hot combs', keywords: ['flat iron', 'curling iron', 'straightener', 'hot comb'] },
  { code: '8510.20', rate: 0, description: 'Electric hair clippers and trimmers', keywords: ['clipper', 'trimmer'] },
  { code: '7604.29', rate: 0.5, description: 'Aluminium bars, rods and profiles (extrusions), not alloyed hollow', keywords: ['aluminum', 'aluminium', 'extrusion', 'profile'] },
  { code: '7326.90', rate: 0.5, description: 'Other articles of iron or steel: brackets, fittings', keywords: ['steel', 'bracket', 'iron'] },
  { code: '3923.21', rate: 0.25, description: 'Sacks, bags and film packaging of polymers of ethylene', keywords: ['poly', 'film', 'bag', 'packaging'] },
  { code: '8415.10', rate: 0.25, description: 'Window or wall air conditioning machines', keywords: ['air conditioner', 'ac unit', 'hvac'] },
  { code: '7610.10', rate: 0.25, description: 'Aluminium doors, windows and their frames', keywords: ['casement', 'window frame', 'frame assembly', 'door frame'] },
  { code: '7008.00', rate: 0.25, description: 'Multiple-walled insulating units of glass', keywords: ['insulated glass', 'glass unit', 'double-pane', 'triple-pane'] },
  { code: '8302.41', rate: 0.25, description: 'Base metal mountings and fittings for buildings: window hardware, locks, cranks, hinges', keywords: ['hardware', 'crank', 'lock', 'hinge'] },
  { code: '3916.20', rate: 0.25, description: 'Profiles of polymers of vinyl chloride (PVC)', keywords: ['vinyl', 'pvc', 'profile'] },
];

export const RATE_BY_CODE = Object.fromEntries(TARIFFS.map((t) => [t.code, t.rate]));

export function tariffText(t) {
  return `${t.code} ${t.description}`;
}
