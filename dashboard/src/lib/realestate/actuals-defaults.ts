// Real-world ("actual") expenses logged against a deal's construction budget,
// for planned-vs-actual tracking. Stored in inputs.actualExpenses (JSONB); the
// engine ignores them entirely (they never affect the modelled economics). No
// imports here so defaults.ts can use the normalizer without an import cycle.

export const PAYMENT_METHODS = ["Bank transfer", "UPI", "Cash", "Card", "Cheque", "Other"] as const;
export const ACTUAL_STATUSES = ["paid", "pending", "partial"] as const;
export type ActualStatus = (typeof ACTUAL_STATUSES)[number];

export type ActualExpense = {
  id: string;
  name: string;
  description?: string;
  amount: number; // actual ₹ spent
  date: string; // ISO YYYY-MM-DD ("" if unset)
  category?: string; // links to a budget category
  expenseId?: string; // optional link to a specific budget line item
  vendor?: string;
  method?: string; // one of PAYMENT_METHODS
  reference?: string; // invoice / receipt number
  url?: string; // link to the receipt / invoice document
  status: ActualStatus;
  createdAt: number;
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const finite = (v: unknown, fallback = 0, min = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, safe);
};

/**
 * A row carrying no real logged spend — only the defaults the "+ Log an expense"
 * button seeds (a category, status "paid", an id). Category/method/status are
 * deliberately ignored: a real expense has at least an amount, a name, a vendor, a
 * date, a reference, a receipt URL, a note, or an explicit budget-line link. Used
 * to keep phantom ₹0 rows out of the DB (normalize) and out of the count badge.
 */
export function isBlankActual(a: Partial<ActualExpense>): boolean {
  return (
    !(typeof a.amount === "number" && a.amount > 0) &&
    !str(a.name).trim() &&
    !str(a.vendor).trim() &&
    !str(a.date).trim() &&
    !str(a.reference).trim() &&
    !str(a.url).trim() &&
    !str(a.description).trim() &&
    !str(a.expenseId).trim()
  );
}

/** How many actuals represent real logged spend — drives the "Actuals (N)" badge. */
export const meaningfulActualsCount = (list: readonly Partial<ActualExpense>[]): number =>
  list.reduce((n, a) => n + (isBlankActual(a) ? 0 : 1), 0);

export function normalizeActualExpenses(raw: unknown): ActualExpense[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRec)
    .map((e, i) => {
      const out: ActualExpense = {
        id: str(e.id) || `act-${i}`,
        name: str(e.name), // raw — the "Expense" display default is applied AFTER the blank filter
        amount: finite(e.amount, 0, 0),
        date: str(e.date),
        status: (ACTUAL_STATUSES as readonly string[]).includes(str(e.status))
          ? (str(e.status) as ActualStatus)
          : "paid",
        createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
      };
      const opt = (k: "description" | "category" | "expenseId" | "vendor" | "method" | "reference" | "url", v: unknown) => {
        const s = str(v);
        if (s) out[k] = s;
      };
      opt("description", e.description);
      opt("category", e.category);
      opt("expenseId", e.expenseId);
      opt("vendor", e.vendor);
      opt("method", e.method);
      opt("reference", e.reference);
      opt("url", e.url);
      return out;
    })
    // Drop fully-blank rows (an abandoned "+ Log an expense" click) so they never
    // persist as phantom ₹0 actuals; then restore the friendly display name default.
    .filter((a) => !isBlankActual(a))
    .map((a) => (a.name ? a : { ...a, name: "Expense" }));
}

export function blankActual(category?: string, expenseId?: string): ActualExpense {
  return {
    id: `act-${Math.random().toString(36).slice(2, 9)}`,
    name: "",
    amount: 0,
    date: "",
    status: "paid",
    createdAt: Date.now(),
    ...(category ? { category } : {}),
    ...(expenseId ? { expenseId } : {}),
  };
}
