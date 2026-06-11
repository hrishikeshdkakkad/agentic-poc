import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Finance",
  description: "Local drill-down dashboard over the personal-finance MCP",
};

const NAV: Array<[string, string]> = [
  ["/", "Overview"],
  ["/accounts", "Accounts"],
  ["/transactions", "Transactions"],
  ["/spending", "Spending"],
  ["/net-worth", "Net worth"],
  ["/investments", "Investments"],
  ["/debt", "Debt"],
  ["/cash-flow", "Cash flow"],
  ["/connections", "Connections"],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-line p-4">
            <div className="mb-6 px-2 font-bold">💰 Finance</div>
            <nav className="flex flex-col gap-1">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href}
                  className="rounded-md px-2 py-1.5 text-sm text-mut hover:bg-card hover:text-txt">
                  {label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
