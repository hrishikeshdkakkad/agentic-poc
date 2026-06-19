import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/components/theme";
import { AppShell } from "@/components/app-shell";
import { AuthSessionProvider } from "@/components/session-provider";

export const metadata: Metadata = {
  title: "Vault · Personal Finance",
  description: "A precise, local drill-down dashboard over the personal-finance MCP.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <AuthSessionProvider>
          <ThemeProvider>
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
