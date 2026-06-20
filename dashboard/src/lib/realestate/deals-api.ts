// Client → local Next route handlers for deal persistence. Same fetch/unwrap
// shape as src/lib/api.ts (which keeps `unwrap` private, so it's repeated here).
import type { Deal } from "./deals";

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export async function fetchDeals(): Promise<Deal[]> {
  const { deals } = await unwrap<{ deals: Deal[] }>(await fetch("/api/realestate/deals"));
  return deals;
}

export async function putDeal(deal: Deal): Promise<Deal> {
  const { deal: saved } = await unwrap<{ deal: Deal }>(
    await fetch(`/api/realestate/deals/${deal.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deal),
    }),
  );
  return saved;
}

export async function deleteDealReq(id: string): Promise<void> {
  await unwrap(await fetch(`/api/realestate/deals/${id}`, { method: "DELETE" }));
}
