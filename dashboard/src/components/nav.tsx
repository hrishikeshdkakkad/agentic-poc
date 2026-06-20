import type { SVGProps } from "react";
import {
  IconAccounts,
  IconCashFlow,
  IconConnections,
  IconDebt,
  IconInvestments,
  IconNetWorth,
  IconOverview,
  IconPlan,
  IconRealEstate,
  IconSpending,
  IconTransactions,
} from "@/components/icons";

type IconCmp = (p: SVGProps<SVGSVGElement> & { size?: number }) => React.ReactElement;

export type NavItem = { href: string; label: string; group: string; icon: IconCmp; blurb: string };

/** Single source of truth for the sidebar and the ⌘K palette. Grouped the way a
 * finance app reads: what you spend, what you're worth, what you manage. */
export const NAV: NavItem[] = [
  { href: "/", label: "Overview", group: "", icon: IconOverview, blurb: "Everything at a glance" },

  { href: "/transactions", label: "Transactions", group: "Money", icon: IconTransactions, blurb: "Filter, drill, correct" },
  { href: "/spending", label: "Spending", group: "Money", icon: IconSpending, blurb: "Where the money goes" },
  { href: "/cash-flow", label: "Cash flow", group: "Money", icon: IconCashFlow, blurb: "Income, expenses, recurring" },

  { href: "/accounts", label: "Accounts", group: "Wealth", icon: IconAccounts, blurb: "Every linked account" },
  { href: "/net-worth", label: "Net worth", group: "Wealth", icon: IconNetWorth, blurb: "History & trajectory" },
  { href: "/investments", label: "Investments", group: "Wealth", icon: IconInvestments, blurb: "Positions & allocation" },
  { href: "/debt", label: "Debt", group: "Wealth", icon: IconDebt, blurb: "Carrying cost & payoff" },

  { href: "/real-estate", label: "Real estate", group: "Ventures", icon: IconRealEstate, blurb: "SMV deal model" },

  { href: "/plan", label: "Plan", group: "Manage", icon: IconPlan, blurb: "The Optimizer game" },
  { href: "/connections", label: "Connections", group: "Manage", icon: IconConnections, blurb: "Link, sync, import" },
];

export const NAV_GROUPS = ["", "Money", "Wealth", "Ventures", "Manage"] as const;

export function pageTitle(pathname: string): { label: string; blurb: string } {
  const exact = NAV.find((n) => n.href === pathname);
  if (exact) return { label: exact.label, blurb: exact.blurb };
  // nested routes fall back to their section root
  const root = NAV.filter((n) => n.href !== "/").find((n) => pathname.startsWith(n.href));
  return root ? { label: root.label, blurb: root.blurb } : { label: "Overview", blurb: "" };
}
