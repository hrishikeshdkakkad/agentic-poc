import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Playfair_Display, Source_Serif_4 } from "next/font/google";
import "./globals.css";

// Newsroom faces (/news only — referenced via .newsroom-scoped utilities, the
// rest of the app stays on Geist). Playfair: the nameplate & headline didone;
// Source Serif: the body text, with real italics for deks and datelines.
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-source-serif",
  display: "swap",
});
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
      className={`${GeistSans.variable} ${GeistMono.variable} ${playfair.variable} ${sourceSerif.variable}`}
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
