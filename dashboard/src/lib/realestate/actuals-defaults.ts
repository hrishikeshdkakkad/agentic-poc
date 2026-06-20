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

export function normalizeActualExpenses(raw: unknown): ActualExpense[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRec).map((e, i) => {
    const out: ActualExpense = {
      id: str(e.id) || `act-${i}`,
      name: str(e.name) || "Expense",
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
  });
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
