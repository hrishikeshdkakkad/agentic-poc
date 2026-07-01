/** Hand-tuned stroke icons (Lucide-grammar): 24×24, currentColor, 1.75 stroke.
 * No emoji anywhere in the chrome — that alone reads as a step up in polish. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5" />
    <rect x="13.5" y="12" width="7.5" height="9" rx="1.5" />
    <rect x="3" y="15.5" width="7.5" height="5.5" rx="1.5" />
  </Svg>
);
export const IconAccounts = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M2.5 9.5h19" />
    <path d="M16.5 14.5h2" />
  </Svg>
);
export const IconTransactions = (p: P) => (
  <Svg {...p}>
    <path d="M7 7h13" />
    <path d="m17 4 3 3-3 3" />
    <path d="M17 17H4" />
    <path d="m7 14-3 3 3 3" />
  </Svg>
);
export const IconSpending = (p: P) => (
  <Svg {...p}>
    <path d="M21 12A9 9 0 1 1 12 3v9z" />
    <path d="M12 3a9 9 0 0 1 9 9h-9z" opacity="0.55" />
  </Svg>
);
export const IconPlan = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
  </Svg>
);
export const IconNetWorth = (p: P) => (
  <Svg {...p}>
    <path d="M3 17 9 11l4 4 8-8" />
    <path d="M21 7v5" />
    <path d="M21 7h-5" />
  </Svg>
);
export const IconInvestments = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <rect x="7" y="11" width="2.8" height="6" rx="0.6" />
    <rect x="12.6" y="7" width="2.8" height="10" rx="0.6" />
    <rect x="18.2" y="13" width="0.2" height="4" />
    <rect x="17.4" y="9" width="2.8" height="8" rx="0.6" />
  </Svg>
);
export const IconDebt = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19" />
    <path d="M6 15h4" />
  </Svg>
);
export const IconCashFlow = (p: P) => (
  <Svg {...p}>
    <path d="M3 7h13l-3-3" />
    <path d="M3 7l3 3" />
    <path d="M21 17H8l3 3" />
    <path d="M21 17l-3-3" />
  </Svg>
);
export const IconConnections = (p: P) => (
  <Svg {...p}>
    <path d="M9 15 4.5 19.5a3.5 3.5 0 0 1-5-5L4 10" opacity="0" />
    <path d="m9.5 14.5 5-5" />
    <path d="M7.5 11 5 13.5a3.5 3.5 0 0 0 5 5l2.5-2.5" />
    <path d="M16.5 13 19 10.5a3.5 3.5 0 0 0-5-5L11.5 8" />
  </Svg>
);

export const IconRealEstate = (p: P) => (
  <Svg {...p}>
    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
    <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
  </Svg>
);

export const IconNews = (p: P) => (
  <Svg {...p}>
    <path d="M4 4h13a1 1 0 0 1 1 1v13.5" />
    <path d="M18 18.5a1.5 1.5 0 0 0 3 0V8h-3" />
    <path d="M4 4v14.5A1.5 1.5 0 0 0 5.5 20H19" />
    <path d="M7 8h7M7 12h7M7 16h4" />
  </Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z" />
  </Svg>
);
export const IconSync = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 4v4h-4" />
    <path d="M3 20v-4h4" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);
export const IconArrowUpRight = (p: P) => (
  <Svg {...p}>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </Svg>
);
export const IconArrowDownRight = (p: P) => (
  <Svg {...p}>
    <path d="M7 7 17 17" />
    <path d="M17 8v9H8" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconCornerDownLeft = (p: P) => (
  <Svg {...p}>
    <path d="m9 10-5 5 5 5" />
    <path d="M20 4v7a4 4 0 0 1-4 4H4" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 15V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconFilter = (p: P) => (
  <Svg {...p}>
    <path d="M3 5h18l-7 8v6l-4-2v-4z" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 19h16" />
  </Svg>
);
export const IconWallet = (p: P) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h12v4" />
    <path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" />
    <path d="M21 9v3h-5a1.5 1.5 0 0 1 0-3z" />
  </Svg>
);

/** The brand mark — a stylized vault/aperture, drawn not emoji'd. */
export const BrandMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="var(--accent)" opacity="0.14" />
    <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" stroke="var(--accent)" strokeWidth="1.4" opacity="0.4" />
    <circle cx="16" cy="16" r="7.5" stroke="var(--accent)" strokeWidth="1.8" />
    <circle cx="16" cy="16" r="2.6" fill="var(--accent)" />
    <path d="M16 6.5v3M16 22.5v3M6.5 16h3M22.5 16h3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
