// Comprehensive itemized construction budget for the real-estate model.
//
// This is the *decomposition* of the SMV build budget — the coarse
// `(constructionRate + extrasRate) × builtUp = ₹2,05,20,000` for a 4-unit,
// 7,200-sqft Bangalore residential project — into ~114 real line items across
// 18 categories, each with a cash-flow month on the CF grid (0,3,…,24).
//
// INVARIANT: Σ(amount) === 20_520_000 (asserted by construction.test.ts). The
// engine derives `buildSubtotal` from this sum, so the total must equal the
// coarse build budget to preserve the parity-locked headline numbers. `amount`
// is authoritative; qty/unit/rate are descriptive metadata.

export const CONSTRUCTION_CATEGORIES = [
  "Preliminaries & site setup",
  "Professional & approvals",
  "Earthwork & substructure",
  "RCC — concrete",
  "RCC — reinforcement steel",
  "RCC — formwork",
  "Masonry & blockwork",
  "Plastering",
  "Waterproofing",
  "Flooring & tiling",
  "Doors & windows",
  "Plumbing & sanitary",
  "Electrical",
  "Painting & finishes",
  "Kitchen & joinery",
  "Railings & metalwork",
  "External & site development",
  "Miscellaneous & sundries",
] as const;

export type ConstructionCategory = (typeof CONSTRUCTION_CATEGORIES)[number];

export type ConstructionExpense = {
  id: string;
  category: string; // one of CONSTRUCTION_CATEGORIES (free-form tolerated)
  item: string;
  qty: number; // descriptive (1 when lumpsum)
  unit: string; // sqft | cum | kg | MT | nos | rmt | point | lumpsum | …
  rate: number; // ₹ per unit (descriptive; == amount when lumpsum)
  amount: number; // ₹ — AUTHORITATIVE total
  month: number; // CF grid month the expense is incurred (0,3,…,24)
  notes?: string;
};

const LS = "lumpsum";

export const DEFAULT_CONSTRUCTION_EXPENSES: ConstructionExpense[] = [
  // ── Preliminaries & site setup (₹4,10,000) ──
  { id: "prelim-clearing", category: "Preliminaries & site setup", item: "Site clearing & leveling", qty: 1, unit: LS, rate: 60000, amount: 60000, month: 0 },
  { id: "prelim-office", category: "Preliminaries & site setup", item: "Temporary site office & store", qty: 1, unit: LS, rate: 80000, amount: 80000, month: 0 },
  { id: "prelim-utilities", category: "Preliminaries & site setup", item: "Temporary water & power connection", qty: 1, unit: LS, rate: 70000, amount: 70000, month: 0 },
  { id: "prelim-barricade", category: "Preliminaries & site setup", item: "Site fencing / barricading", qty: 1, unit: LS, rate: 65000, amount: 65000, month: 0 },
  { id: "prelim-survey", category: "Preliminaries & site setup", item: "Survey & layout marking", qty: 1, unit: LS, rate: 45000, amount: 45000, month: 0 },
  { id: "prelim-borewell", category: "Preliminaries & site setup", item: "Borewell / construction water arrangement", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 0 },

  // ── Professional & approvals (₹7,20,000) ──
  { id: "prof-arch", category: "Professional & approvals", item: "Architectural design & drawings", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 0 },
  { id: "prof-struct", category: "Professional & approvals", item: "Structural engineering & drawings", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 0 },
  { id: "prof-mep", category: "Professional & approvals", item: "MEP consultant (plumbing/electrical)", qty: 1, unit: LS, rate: 70000, amount: 70000, month: 0 },
  { id: "prof-soil", category: "Professional & approvals", item: "Soil investigation / geotech report", qty: 1, unit: LS, rate: 45000, amount: 45000, month: 0 },
  { id: "prof-sanction", category: "Professional & approvals", item: "BBMP plan sanction & scrutiny fees", qty: 1, unit: LS, rate: 150000, amount: 150000, month: 3 },
  { id: "prof-cess", category: "Professional & approvals", item: "Betterment charges / labour cess", qty: 1, unit: LS, rate: 95000, amount: 95000, month: 3 },
  { id: "prof-pmc", category: "Professional & approvals", item: "Site engineer / project management", qty: 1, unit: LS, rate: 60000, amount: 60000, month: 3 },

  // ── Earthwork & substructure (₹16,40,000) ──
  { id: "sub-excavation", category: "Earthwork & substructure", item: "Excavation for foundation", qty: 600, unit: "cum", rate: 250, amount: 150000, month: 0 },
  { id: "sub-pcc", category: "Earthwork & substructure", item: "PCC bed below footings", qty: 40, unit: "cum", rate: 6500, amount: 260000, month: 0 },
  { id: "sub-termite", category: "Earthwork & substructure", item: "Anti-termite treatment", qty: 1, unit: LS, rate: 65000, amount: 65000, month: 0 },
  { id: "sub-footings", category: "Earthwork & substructure", item: "Foundation footings RCC", qty: 1, unit: LS, rate: 380000, amount: 380000, month: 3 },
  { id: "sub-plinth", category: "Earthwork & substructure", item: "Plinth beams & plinth filling", qty: 1, unit: LS, rate: 320000, amount: 320000, month: 3 },
  { id: "sub-backfill", category: "Earthwork & substructure", item: "Backfilling & compaction", qty: 1, unit: LS, rate: 95000, amount: 95000, month: 3 },
  { id: "sub-sump", category: "Earthwork & substructure", item: "Sump / underground water tank (RCC)", qty: 1, unit: LS, rate: 250000, amount: 250000, month: 3 },
  { id: "sub-dpc", category: "Earthwork & substructure", item: "Damp proof course (DPC)", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 3 },

  // ── RCC — concrete (₹24,60,000) ──
  { id: "rcc-columns", category: "RCC — concrete", item: "Columns concrete (M25)", qty: 1, unit: LS, rate: 520000, amount: 520000, month: 3 },
  { id: "rcc-beams", category: "RCC — concrete", item: "Beams concrete", qty: 1, unit: LS, rate: 480000, amount: 480000, month: 6 },
  { id: "rcc-slab-gf", category: "RCC — concrete", item: "Ground-floor slab concrete", qty: 1, unit: LS, rate: 190000, amount: 190000, month: 6 },
  { id: "rcc-slab-ff", category: "RCC — concrete", item: "First-floor slab concrete", qty: 1, unit: LS, rate: 190000, amount: 190000, month: 6 },
  { id: "rcc-slab-sf", category: "RCC — concrete", item: "Second-floor slab concrete", qty: 1, unit: LS, rate: 190000, amount: 190000, month: 9 },
  { id: "rcc-slab-terrace", category: "RCC — concrete", item: "Terrace slab concrete", qty: 1, unit: LS, rate: 190000, amount: 190000, month: 9 },
  { id: "rcc-staircase", category: "RCC — concrete", item: "Staircase concrete", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 9 },
  { id: "rcc-oht", category: "RCC — concrete", item: "Overhead tank (OHT) RCC", qty: 1, unit: LS, rate: 140000, amount: 140000, month: 12 },
  { id: "rcc-lift", category: "RCC — concrete", item: "Lift pit & machine-room RCC", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 9 },
  { id: "rcc-lintels", category: "RCC — concrete", item: "Lintels, sunshades & chajja", qty: 1, unit: LS, rate: 160000, amount: 160000, month: 9 },
  { id: "rcc-pump-cure", category: "RCC — concrete", item: "Concrete pumping & curing", qty: 1, unit: LS, rate: 100000, amount: 100000, month: 6 },

  // ── RCC — reinforcement steel (₹20,50,000) ──
  { id: "steel-found", category: "RCC — reinforcement steel", item: "TMT steel Fe500 — footings/foundation", qty: 7, unit: "MT", rate: 65000, amount: 455000, month: 3 },
  { id: "steel-columns", category: "RCC — reinforcement steel", item: "TMT steel — columns", qty: 5, unit: "MT", rate: 65000, amount: 325000, month: 6 },
  { id: "steel-beams", category: "RCC — reinforcement steel", item: "TMT steel — beams", qty: 5, unit: "MT", rate: 65000, amount: 325000, month: 6 },
  { id: "steel-slabs", category: "RCC — reinforcement steel", item: "TMT steel — slabs", qty: 8, unit: "MT", rate: 65000, amount: 520000, month: 6 },
  { id: "steel-staircase", category: "RCC — reinforcement steel", item: "TMT steel — staircase", qty: 1.5, unit: "MT", rate: 65000, amount: 97500, month: 9 },
  { id: "steel-binding", category: "RCC — reinforcement steel", item: "Binding wire, chairs & spacers", qty: 1, unit: LS, rate: 50000, amount: 50000, month: 6 },
  { id: "steel-labour", category: "RCC — reinforcement steel", item: "Steel cutting, bending & fixing labour", qty: 1, unit: LS, rate: 277500, amount: 277500, month: 6 },

  // ── RCC — formwork (₹8,20,000) ──
  { id: "form-columns", category: "RCC — formwork", item: "Shuttering — columns", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 6 },
  { id: "form-slabs", category: "RCC — formwork", item: "Shuttering — beams & slabs", qty: 1, unit: LS, rate: 360000, amount: 360000, month: 6 },
  { id: "form-staircase", category: "RCC — formwork", item: "Shuttering — staircase", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 9 },
  { id: "form-props", category: "RCC — formwork", item: "Props & scaffolding for slabs", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 6 },
  { id: "form-deshutter", category: "RCC — formwork", item: "De-shuttering & cleaning", qty: 1, unit: LS, rate: 80000, amount: 80000, month: 9 },

  // ── Masonry & blockwork (₹14,40,000) ──
  { id: "mas-ext", category: "Masonry & blockwork", item: 'External walls — solid concrete blocks (8")', qty: 1, unit: LS, rate: 560000, amount: 560000, month: 9 },
  { id: "mas-int", category: "Masonry & blockwork", item: 'Internal partition walls (4")', qty: 1, unit: LS, rate: 380000, amount: 380000, month: 9 },
  { id: "mas-parapet", category: "Masonry & blockwork", item: "Parapets & duct blockwork", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 12 },
  { id: "mas-bands", category: "Masonry & blockwork", item: "RCC / lintel bands in masonry", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 12 },
  { id: "mas-labour", category: "Masonry & blockwork", item: "Mortar & masonry labour", qty: 1, unit: LS, rate: 270000, amount: 270000, month: 9 },

  // ── Plastering (₹10,30,000) ──
  { id: "plaster-int", category: "Plastering", item: "Internal wall plastering", qty: 14000, unit: "sqft", rate: 28, amount: 392000, month: 12 },
  { id: "plaster-ceiling", category: "Plastering", item: "Ceiling plastering", qty: 1, unit: LS, rate: 230000, amount: 230000, month: 12 },
  { id: "plaster-ext", category: "Plastering", item: "External wall plastering (double coat)", qty: 1, unit: LS, rate: 308000, amount: 308000, month: 12 },
  { id: "plaster-wp", category: "Plastering", item: "Waterproof plaster (wet areas)", qty: 1, unit: LS, rate: 100000, amount: 100000, month: 15 },

  // ── Waterproofing (₹5,10,000) ──
  { id: "wp-terrace", category: "Waterproofing", item: "Terrace waterproofing (brickbat coba / APP)", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 15 },
  { id: "wp-bath", category: "Waterproofing", item: "Bathroom & balcony waterproofing", qty: 1, unit: LS, rate: 150000, amount: 150000, month: 15 },
  { id: "wp-sunken", category: "Waterproofing", item: "Sunken slab waterproofing", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 15 },
  { id: "wp-tanks", category: "Waterproofing", item: "Sump & OHT waterproofing", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 15 },

  // ── Flooring & tiling (₹18,50,000) ──
  { id: "floor-vitrified", category: "Flooring & tiling", item: "Vitrified tiles — living/bedrooms (supply)", qty: 5500, unit: "sqft", rate: 120, amount: 660000, month: 18 },
  { id: "floor-labour", category: "Flooring & tiling", item: "Tile laying labour & adhesive", qty: 1, unit: LS, rate: 280000, amount: 280000, month: 18 },
  { id: "floor-bath", category: "Flooring & tiling", item: "Bathroom wall & floor tiles", qty: 1, unit: LS, rate: 230000, amount: 230000, month: 18 },
  { id: "floor-kitchen", category: "Flooring & tiling", item: "Kitchen floor & dado tiles", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 18 },
  { id: "floor-staircase", category: "Flooring & tiling", item: "Staircase granite / treads", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 18 },
  { id: "floor-lobby", category: "Flooring & tiling", item: "Lobby / common-area flooring", qty: 1, unit: LS, rate: 150000, amount: 150000, month: 18 },
  { id: "floor-skirting", category: "Flooring & tiling", item: "Skirting", qty: 1, unit: LS, rate: 70000, amount: 70000, month: 18 },
  { id: "floor-parking", category: "Flooring & tiling", item: "Parking / utility flooring (tremix)", qty: 1, unit: LS, rate: 160000, amount: 160000, month: 18 },

  // ── Doors & windows (₹15,40,000) ──
  { id: "dw-main", category: "Doors & windows", item: "Main door — teak frame & shutter", qty: 4, unit: "nos", rate: 35000, amount: 140000, month: 18 },
  { id: "dw-internal", category: "Doors & windows", item: "Internal doors — flush / WPC", qty: 24, unit: "nos", rate: 12000, amount: 288000, month: 18 },
  { id: "dw-bath", category: "Doors & windows", item: "Bathroom doors (WPC / PVC)", qty: 12, unit: "nos", rate: 7000, amount: 84000, month: 18 },
  { id: "dw-upvc", category: "Doors & windows", item: "UPVC windows", qty: 1200, unit: "sqft", rate: 450, amount: 540000, month: 15 },
  { id: "dw-ventilators", category: "Doors & windows", item: "Ventilators & louvers", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 15 },
  { id: "dw-grills", category: "Doors & windows", item: "MS safety grills", qty: 1200, unit: "sqft", rate: 180, amount: 216000, month: 18 },
  { id: "dw-hardware", category: "Doors & windows", item: "Door hardware (locks/hinges/handles)", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 18 },
  { id: "dw-glazing", category: "Doors & windows", item: "Window glazing & mosquito mesh", qty: 1, unit: LS, rate: 72000, amount: 72000, month: 18 },

  // ── Plumbing & sanitary (₹14,40,000) ──
  { id: "plumb-supply", category: "Plumbing & sanitary", item: "CPVC/UPVC supply piping (rough-in)", qty: 1, unit: LS, rate: 240000, amount: 240000, month: 9 },
  { id: "plumb-drainage", category: "Plumbing & sanitary", item: "Drainage & soil piping (PVC)", qty: 1, unit: LS, rate: 200000, amount: 200000, month: 9 },
  { id: "plumb-sanitaryware", category: "Plumbing & sanitary", item: "Sanitaryware (WC, washbasins)", qty: 1, unit: LS, rate: 260000, amount: 260000, month: 18 },
  { id: "plumb-cp", category: "Plumbing & sanitary", item: "CP fittings (taps/showers/mixers)", qty: 1, unit: LS, rate: 220000, amount: 220000, month: 18 },
  { id: "plumb-pumps", category: "Plumbing & sanitary", item: "Overhead & sump pumps / motors", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 18 },
  { id: "plumb-rwh", category: "Plumbing & sanitary", item: "Rainwater harvesting system", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 18 },
  { id: "plumb-sewage", category: "Plumbing & sanitary", item: "Sewage connection / STP charges", qty: 1, unit: LS, rate: 130000, amount: 130000, month: 21 },
  { id: "plumb-bwssb", category: "Plumbing & sanitary", item: "Water meter & BWSSB connection", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 21 },
  { id: "plumb-labour", category: "Plumbing & sanitary", item: "Plumbing labour", qty: 1, unit: LS, rate: 100000, amount: 100000, month: 18 },

  // ── Electrical (₹14,40,000) ──
  { id: "elec-conduit", category: "Electrical", item: "Concealed conduiting & wiring (rough-in)", qty: 1, unit: LS, rate: 360000, amount: 360000, month: 9 },
  { id: "elec-cables", category: "Electrical", item: "Wires & cables (copper)", qty: 1, unit: LS, rate: 220000, amount: 220000, month: 9 },
  { id: "elec-switches", category: "Electrical", item: "Modular switches & sockets", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 18 },
  { id: "elec-db", category: "Electrical", item: "Distribution boards & MCBs", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 18 },
  { id: "elec-fixtures", category: "Electrical", item: "Light fixtures & fans", qty: 1, unit: LS, rate: 200000, amount: 200000, month: 21 },
  { id: "elec-earthing", category: "Electrical", item: "Earthing & lightning arrestor", qty: 1, unit: LS, rate: 80000, amount: 80000, month: 12 },
  { id: "elec-bescom", category: "Electrical", item: "BESCOM connection & meter", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 21 },
  { id: "elec-inverter", category: "Electrical", item: "Inverter / backup provision & wiring", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 18 },
  { id: "elec-labour", category: "Electrical", item: "Electrical labour", qty: 1, unit: LS, rate: 80000, amount: 80000, month: 18 },

  // ── Painting & finishes (₹9,20,000) ──
  { id: "paint-putty", category: "Painting & finishes", item: "Internal putty (2 coats)", qty: 1, unit: LS, rate: 200000, amount: 200000, month: 18 },
  { id: "paint-int", category: "Painting & finishes", item: "Internal primer + emulsion", qty: 1, unit: LS, rate: 280000, amount: 280000, month: 21 },
  { id: "paint-ext", category: "Painting & finishes", item: "External primer + weatherproof paint", qty: 1, unit: LS, rate: 260000, amount: 260000, month: 21 },
  { id: "paint-enamel", category: "Painting & finishes", item: "Enamel paint (grills/MS/doors)", qty: 1, unit: LS, rate: 80000, amount: 80000, month: 21 },
  { id: "paint-texture", category: "Painting & finishes", item: "Texture / feature-wall finish", qty: 1, unit: LS, rate: 100000, amount: 100000, month: 21 },

  // ── Kitchen & joinery (₹6,20,000) ──
  { id: "kit-counter", category: "Kitchen & joinery", item: "Kitchen granite platform & counter", qty: 1, unit: LS, rate: 160000, amount: 160000, month: 18 },
  { id: "kit-sink", category: "Kitchen & joinery", item: "Stainless steel sink & drainboard", qty: 1, unit: LS, rate: 40000, amount: 40000, month: 18 },
  { id: "kit-dado", category: "Kitchen & joinery", item: "Kitchen dado tiles (above counter)", qty: 1, unit: LS, rate: 60000, amount: 60000, month: 18 },
  { id: "kit-modular", category: "Kitchen & joinery", item: "Modular kitchen base & overhead units", qty: 1, unit: LS, rate: 220000, amount: 220000, month: 21 },
  { id: "kit-wardrobes", category: "Kitchen & joinery", item: "Bedroom wardrobes (basic)", qty: 1, unit: LS, rate: 140000, amount: 140000, month: 21 },

  // ── Railings & metalwork (₹5,10,000) ──
  { id: "rail-stair", category: "Railings & metalwork", item: "SS railing — staircase", qty: 60, unit: "rmt", rate: 3500, amount: 210000, month: 18 },
  { id: "rail-balcony", category: "Railings & metalwork", item: "MS/SS railing — balconies", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 18 },
  { id: "rail-gate", category: "Railings & metalwork", item: "MS gate / grills (utility)", qty: 1, unit: LS, rate: 70000, amount: 70000, month: 21 },
  { id: "rail-fab", category: "Railings & metalwork", item: "Handrails & misc fabrication", qty: 1, unit: LS, rate: 50000, amount: 50000, month: 18 },

  // ── External & site development (₹10,30,000) ──
  { id: "ext-compound", category: "External & site development", item: "Compound wall (RCC + block)", qty: 120, unit: "rmt", rate: 3500, amount: 420000, month: 21 },
  { id: "ext-gate", category: "External & site development", item: "Main gate (MS / automated)", qty: 1, unit: LS, rate: 120000, amount: 120000, month: 24 },
  { id: "ext-driveway", category: "External & site development", item: "Driveway / paver block / concrete", qty: 1, unit: LS, rate: 180000, amount: 180000, month: 24 },
  { id: "ext-landscape", category: "External & site development", item: "Landscaping & garden", qty: 1, unit: LS, rate: 90000, amount: 90000, month: 24 },
  { id: "ext-stormdrain", category: "External & site development", item: "External & storm-water drainage", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 21 },
  { id: "ext-septic", category: "External & site development", item: "Septic tank / soak pit", qty: 1, unit: LS, rate: 110000, amount: 110000, month: 21 },

  // ── Miscellaneous & sundries (₹90,000) ──
  { id: "misc-debris", category: "Miscellaneous & sundries", item: "Debris removal & housekeeping", qty: 1, unit: LS, rate: 35000, amount: 35000, month: 24 },
  { id: "misc-wastage", category: "Miscellaneous & sundries", item: "Material wastage & sundries", qty: 1, unit: LS, rate: 30000, amount: 30000, month: 12 },
  { id: "misc-handover", category: "Miscellaneous & sundries", item: "Final cleaning & handover", qty: 1, unit: LS, rate: 25000, amount: 25000, month: 24 },
];

// CF grid duplicated here on purpose — importing it from ./defaults would create
// a cycle (defaults.ts imports this module for the template + normalizers).
const CF_GRID = [0, 3, 6, 9, 12, 15, 18, 21, 24];

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const finite = (v: unknown, fallback: number, min = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, safe);
};

const nearestGridMonth = (m: number): number =>
  CF_GRID.reduce((best, x) => (Math.abs(x - m) < Math.abs(best - m) ? x : best), CF_GRID[0]);

/** Authoritative build total = Σ line-item amounts. */
export const sumExpenses = (list: readonly ConstructionExpense[] | undefined): number =>
  (Array.isArray(list) ? list : []).reduce(
    (s, e) => s + (e && Number.isFinite(e.amount) ? e.amount : 0),
    0,
  );

/**
 * Scale a list so amounts sum exactly to `target` (fits the default template to
 * a deal's build budget on migration). Rounding drift lands on the last line.
 */
export function scaleExpensesTo(
  list: readonly ConstructionExpense[],
  target: number,
): ConstructionExpense[] {
  const total = sumExpenses(list);
  const factor = total > 0 && target > 0 ? target / total : 1;
  const scaled = list.map((e, i) => {
    const id = e.id || `ce-${i}`;
    // For metered (non-lumpsum) lines, scale the RATE and derive amount = qty×rate,
    // so the line is internally consistent with how the editor recomputes amount on
    // a qty/rate edit. Lumpsum lines carry the amount directly (rate is descriptive).
    if (e.unit === "lumpsum" || e.qty <= 0) {
      const amount = Math.round(e.amount * factor);
      return { ...e, id, amount, rate: amount };
    }
    const rate = Math.round(e.rate * factor);
    return { ...e, id, rate, amount: Math.round(e.qty * rate) };
  });
  if (scaled.length) {
    const drift = Math.round(target) - sumExpenses(scaled);
    const last = scaled[scaled.length - 1];
    scaled[scaled.length - 1] = { ...last, amount: last.amount + drift };
  }
  return scaled;
}

/**
 * Coerce stored/edited construction expenses into valid engine inputs. Only a
 * deal that has NO stored array (pre-itemization shape) gets the default
 * template scaled to its coarse build budget, so migrating an existing deal
 * never shifts its economics. A stored EMPTY array is an intentional edit (the
 * user deleted every line) and must stay empty — buildSubtotal then falls back
 * to the coarse rates — rather than silently resurrecting the ~114-item template.
 */
export function normalizeConstructionExpenses(
  raw: unknown,
  coarseBuildSubtotal: number,
): ConstructionExpense[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRec).map((e, i) => {
      const out: ConstructionExpense = {
        id: typeof e.id === "string" && e.id ? e.id : `ce-${i}`,
        category: typeof e.category === "string" && e.category ? e.category : "Miscellaneous & sundries",
        item: typeof e.item === "string" && e.item ? e.item : "Line item",
        qty: finite(e.qty, 1, 0),
        unit: typeof e.unit === "string" && e.unit ? e.unit : "lumpsum",
        rate: finite(e.rate, 0, 0),
        amount: finite(e.amount, 0, 0),
        month: nearestGridMonth(finite(e.month, 0, 0)),
      };
      if (typeof e.notes === "string" && e.notes) out.notes = e.notes;
      return out;
    });
  }
  const target = coarseBuildSubtotal > 0 ? coarseBuildSubtotal : sumExpenses(DEFAULT_CONSTRUCTION_EXPENSES);
  return scaleExpensesTo(DEFAULT_CONSTRUCTION_EXPENSES, target);
}
