"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState } from "react";
import { fmtDate, usd } from "@/lib/format";
import { Badge, Button, cx } from "@/components/ui";
import { IconDownload, IconSearch } from "@/components/icons";

// Register once at module load (idempotent).
ModuleRegistry.registerModules([AllCommunityModule]);

/* ─────────────────────────  theme  ──────────────────────────────────────────
   One theme, two colour modes. The active mode is chosen by the
   data-ag-theme-mode attribute our ThemeProvider stamps on <html>, so the grid
   re-themes in lockstep with the rest of the app. Values mirror globals.css. */
const SHARED = {
  fontFamily:
    "var(--font-geist-sans), ui-sans-serif, system-ui, -apple-system, sans-serif",
  fontSize: 13,
  headerFontSize: 11.5,
  headerFontWeight: 600 as const,
  cellHorizontalPadding: 14,
  spacing: 7,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  headerRowBorder: true,
  rowBorder: true,
};

export const vaultGridTheme = themeQuartz
  .withParams(SHARED)
  .withParams(
    {
      ...SHARED,
      backgroundColor: "#14181f",
      foregroundColor: "#eceff5",
      borderColor: "#222735",
      headerBackgroundColor: "#11151c",
      headerTextColor: "#8b93a5",
      oddRowBackgroundColor: "rgba(255,255,255,0.013)",
      rowHoverColor: "#1c2230",
      selectedRowBackgroundColor: "rgba(123,140,255,0.14)",
      accentColor: "#7b8cff",
      inputBackgroundColor: "#0f1218",
      inputBorder: { color: "#222735" },
      menuBackgroundColor: "#1a1f28",
      menuTextColor: "#eceff5",
      browserColorScheme: "dark",
    },
    "dark",
  )
  .withParams(
    {
      ...SHARED,
      backgroundColor: "#ffffff",
      foregroundColor: "#11151c",
      borderColor: "#ebedf2",
      headerBackgroundColor: "#f7f8fa",
      headerTextColor: "#5d6677",
      oddRowBackgroundColor: "rgba(16,24,40,0.015)",
      rowHoverColor: "#f3f4f8",
      selectedRowBackgroundColor: "rgba(79,91,224,0.10)",
      accentColor: "#4f5be0",
      inputBackgroundColor: "#ffffff",
      inputBorder: { color: "#e7e9ef" },
      menuBackgroundColor: "#ffffff",
      menuTextColor: "#11151c",
      browserColorScheme: "light",
    },
    "light",
  );

const DEFAULT_COL_DEF: ColDef = {
  sortable: true,
  resizable: true,
  filter: true,
  minWidth: 90,
  suppressHeaderMenuButton: true,
};

/* ─────────────────────────  low-level grid  ────────────────────────────── */

export function DataGrid<T>({
  rowData,
  columnDefs,
  defaultColDef,
  quickFilterText,
  context,
  getRowId,
  onRowClicked,
  onReady,
  pagination,
  paginationPageSize = 50,
  rowHeight = 44,
  height = 480,
  autoHeight = false,
  className = "",
}: {
  rowData: T[] | undefined;
  columnDefs: ColDef[];
  defaultColDef?: ColDef;
  quickFilterText?: string;
  context?: unknown;
  getRowId?: (p: { data: T }) => string;
  onRowClicked?: (e: { data: T }) => void;
  onReady?: (api: GridApi) => void;
  pagination?: boolean;
  paginationPageSize?: number;
  rowHeight?: number;
  height?: number | string;
  autoHeight?: boolean;
  className?: string;
}) {
  const merged = useMemo(() => ({ ...DEFAULT_COL_DEF, ...defaultColDef }), [defaultColDef]);
  return (
    <div
      className={cx("w-full", className)}
      style={autoHeight ? undefined : { height: typeof height === "number" ? `${height}px` : height }}
    >
      <AgGridReact
        theme={vaultGridTheme}
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={merged}
        quickFilterText={quickFilterText}
        context={context}
        getRowId={getRowId ? (p) => getRowId({ data: p.data as T }) : undefined}
        onRowClicked={onRowClicked ? (e) => onRowClicked({ data: e.data as T }) : undefined}
        onGridReady={(e: GridReadyEvent) => onReady?.(e.api)}
        domLayout={autoHeight ? "autoHeight" : "normal"}
        pagination={pagination}
        paginationPageSize={paginationPageSize}
        paginationPageSizeSelector={[25, 50, 100, 200]}
        rowHeight={rowHeight}
        headerHeight={40}
        animateRows
        suppressCellFocus
        suppressDragLeaveHidesColumns
        loadingOverlayComponentParams={{ loadingMessage: "Loading…" }}
        overlayNoRowsTemplate={`<span style="color:var(--mut);font-size:13px">No rows to display</span>`}
      />
    </div>
  );
}

/* ─────────────────────────  high-level card  ───────────────────────────── */

/** Card + toolbar (search · count · actions) + grid. The default for data pages. */
export function DataCard<T>({
  title,
  subtitle,
  icon,
  rowData,
  columnDefs,
  defaultColDef,
  context,
  getRowId,
  onRowClicked,
  searchable = true,
  exportable = true,
  exportName = "export",
  actions,
  countLabel = "rows",
  pagination = true,
  paginationPageSize,
  rowHeight,
  height = 540,
  autoHeight = false,
  className = "",
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  rowData: T[] | undefined;
  columnDefs: ColDef[];
  defaultColDef?: ColDef;
  context?: unknown;
  getRowId?: (p: { data: T }) => string;
  onRowClicked?: (e: { data: T }) => void;
  searchable?: boolean;
  exportable?: boolean;
  exportName?: string;
  actions?: React.ReactNode;
  countLabel?: string;
  pagination?: boolean;
  paginationPageSize?: number;
  rowHeight?: number;
  height?: number | string;
  autoHeight?: boolean;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [api, setApi] = useState<GridApi | null>(null);

  const count = rowData?.length ?? 0;

  return (
    <section
      className={cx(
        "overflow-hidden rounded-[var(--radius-lg)] border border-line bg-card shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="text-mut">{icon}</span>}
          <div className="min-w-0">
            {title && <div className="truncate text-[13px] font-semibold tracking-tight text-txt">{title}</div>}
            <div className="truncate text-xs text-mut">
              {subtitle ?? (
                <>
                  {count.toLocaleString()} {countLabel}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {searchable && (
            <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-1.5 focus-within:border-line-strong">
              <IconSearch size={15} className="text-mut" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="w-32 bg-transparent text-[13px] text-txt outline-none placeholder:text-faint sm:w-44"
              />
            </div>
          )}
          {actions}
          {exportable && (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconDownload size={14} />}
              onClick={() => api?.exportDataAsCsv({ fileName: `${exportName}.csv` })}
            >
              <span className="hidden sm:inline">Export</span>
            </Button>
          )}
        </div>
      </header>
      <DataGrid<T>
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={q}
        context={context}
        getRowId={getRowId}
        onRowClicked={onRowClicked}
        onReady={setApi}
        pagination={pagination}
        paginationPageSize={paginationPageSize}
        rowHeight={rowHeight}
        height={height}
        autoHeight={autoHeight}
      />
    </section>
  );
}

/* ─────────────────────────  cell renderers  ────────────────────────────── */

/** Plaid-sign money: inflows (negative) render green with +. */
export function MoneyCell(p: ICellRendererParams) {
  const v = p.value as number | null | undefined;
  if (v == null) return <span className="ag-cell-num text-faint">—</span>;
  const inflow = v < 0;
  const text = inflow ? `+${usd(-v)}` : usd(v);
  return <span className={cx("ag-cell-num", inflow && "ag-cell-inflow")}>{text}</span>;
}

/** Plain balance: negative renders red. */
export function BalanceCell(p: ICellRendererParams) {
  const v = p.value as number | null | undefined;
  if (v == null) return <span className="ag-cell-num text-faint">—</span>;
  return <span className={cx("ag-cell-num", v < 0 && "ag-cell-neg")}>{usd(v)}</span>;
}

/** Signed gain/loss: + green / − red, with optional pct suffix from data[pctField]. */
export function makeGainCell(pctField?: string) {
  return function GainCell(p: ICellRendererParams) {
    const v = p.value as number | null | undefined;
    if (v == null) return <span className="ag-cell-num text-faint">—</span>;
    const pctVal = pctField ? (p.data?.[pctField] as number | null | undefined) : null;
    return (
      <span className={cx("ag-cell-num", v >= 0 ? "ag-cell-pos" : "ag-cell-neg")}>
        {v >= 0 ? "+" : "−"}
        {usd(Math.abs(v))}
        {pctVal != null && <span className="ml-1 text-xs opacity-80">({pctVal > 0 ? "+" : ""}{pctVal}%)</span>}
      </span>
    );
  };
}

export function DateCell(p: ICellRendererParams) {
  return <span className="text-mut">{fmtDate(p.value as string)}</span>;
}

export function TagsCell(p: ICellRendererParams) {
  const tags = (p.value as string[] | undefined) ?? [];
  if (!tags.length) return <span className="text-faint">—</span>;
  return (
    <span className="flex items-center gap-1">
      {tags.map((t) => (
        <Badge key={t} tone="accent">
          {t}
        </Badge>
      ))}
    </span>
  );
}

/** Subtle pill for category/type strings. */
export function ChipCell(p: ICellRendererParams) {
  const v = p.value as string | null | undefined;
  if (!v) return <span className="text-faint">—</span>;
  return (
    <span className="rounded-md border border-line bg-elevated px-2 py-0.5 text-xs font-medium text-mut">
      {String(v).replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

/** Inline proportion bar — pass a field holding 0–100 via cellRendererParams.field. */
export function makeBarCell(field: string, tone: "accent" | "green" | "red" = "accent") {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : "var(--accent)";
  return function BarCell(p: ICellRendererParams) {
    const share = Number(p.data?.[field] ?? 0);
    if (!Number.isFinite(share) || share < 0) return <span className="text-faint">—</span>;
    // A bar past 100% means "over" (e.g. committed > budget) — paint it red and cap
    // the width, so an over-budget or unbudgeted line never reads as a tidy on-target bar.
    const over = share > 100;
    return (
      <span className="flex h-full items-center gap-2">
        <span className="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full"
            style={{ width: `${Math.min(100, share)}%`, background: over ? "var(--red)" : color }}
          />
        </span>
      </span>
    );
  };
}

/* ─────────────────────────  colDef helpers  ────────────────────────────── */

/** Right-aligned numeric column with tabular figures. */
export function numCol(over: Partial<ColDef> = {}): Partial<ColDef> {
  return {
    type: "rightAligned",
    cellClass: "ag-cell-num",
    headerClass: "ag-right-header",
    ...over,
  };
}

export const usdFormatter = (p: ValueFormatterParams) =>
  p.value == null ? "—" : usd(Number(p.value));

export const pctFormatter = (p: ValueFormatterParams) =>
  p.value == null ? "—" : `${Number(p.value).toFixed(1)}%`;

export type { ColDef, GridApi };
