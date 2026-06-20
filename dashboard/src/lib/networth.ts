// Pure helpers over the get_net_worth_history payload (dated balance snapshots
// from Postgres). Kept dependency-free so it's trivially testable.

export type NetWorthSnapshot = { date: string; net_worth: number };
export type NetWorthHistory = { history: NetWorthSnapshot[] };

/**
 * Net worth from the most-recent snapshot, or null if there are none. Rows
 * arrive ordered by date, but we pick the max date defensively so a change in
 * server ordering can't silently surface a stale figure.
 */
export function latestNetWorth(h: NetWorthHistory | undefined | null): number | null {
  if (!h?.history?.length) return null;
  return h.history.reduce((a, b) => (b.date > a.date ? b : a)).net_worth;
}
