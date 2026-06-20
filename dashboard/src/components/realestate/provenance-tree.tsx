"use client";

// Recursive drill-down over a TraceNode. Every figure expands to its exact
// derivation down to budget line items; rows show the EXACT rupee figure (inr())
// and the root carries a "Σ reconciles" proof — the cent-accurate contract made
// visible. Heroes elsewhere stay in ₹Cr; this is the drill-down, so it's exact.

import { useState } from "react";
import type { TraceNode } from "@/lib/realestate/trace";
import { cr, inr, mult, pct, rate } from "@/lib/realestate/format";
import { cx } from "@/components/ui";
import { IconChevronRight } from "@/components/icons";

const display = (n: TraceNode): string => {
  switch (n.unit) {
    case "pct":
      return pct(n.value);
    case "rate":
      return rate(n.value);
    case "x":
      return mult(n.value);
    case "sqft":
      return `${Math.round(n.value).toLocaleString("en-IN")} sqft`;
    case "num":
      return n.value.toLocaleString("en-IN");
    default:
      return inr(n.value);
  }
};

function Row({ node, depth, defaultOpenDepth }: { node: TraceNode; depth: number; defaultOpenDepth: number }) {
  const hasKids = !!node.children?.length;
  const [open, setOpen] = useState(depth < defaultOpenDepth);
  return (
    <>
      <div
        className="flex items-start gap-2 border-t border-line py-1.5"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <button
          type="button"
          aria-label={hasKids ? (open ? "Collapse" : "Expand") : undefined}
          disabled={!hasKids}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-faint transition-colors hover:text-txt",
            !hasKids && "invisible",
          )}
        >
          <IconChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cx("text-[13px]", depth === 0 ? "font-semibold text-txt" : "text-txt")}>
              {node.label}
            </span>
            {node.formula && <span className="text-[11px] text-faint">{node.formula}</span>}
          </div>
          {node.sub && <div className="text-[11px] text-faint">{node.sub}</div>}
          {node.note && <div className="mt-0.5 text-[11px] text-amber">{node.note}</div>}
        </div>
        <span
          className={cx("nums shrink-0 text-right text-[13px] tabular-nums text-txt", depth === 0 && "font-semibold")}
          title={node.unit === "inr" ? inr(node.value) : undefined}
        >
          {display(node)}
        </span>
      </div>
      {open &&
        hasKids &&
        node.children!.map((c) => (
          <Row key={c.key} node={c} depth={depth + 1} defaultOpenDepth={defaultOpenDepth} />
        ))}
    </>
  );
}

/** Reconciliation proof for a sum root: Σ children == value, to the rupee. */
function Reconcile({ node }: { node: TraceNode }) {
  if (node.op !== "sum" || !node.children?.length) return null;
  const sum = node.children.reduce((s, c) => s + c.value, 0);
  const ok = Math.abs(sum - node.value) < 0.5;
  return (
    <div className="flex items-center justify-end gap-1.5 border-t border-line-strong py-1.5 pr-1 text-[11px]">
      {ok ? (
        <span className="text-green">Σ reconciles to {cr(node.value)} ✓</span>
      ) : (
        <span className="text-red">Σ off by {inr(sum - node.value)}</span>
      )}
    </div>
  );
}

export function TraceTree({
  node,
  defaultOpenDepth = 1,
}: {
  node: TraceNode;
  defaultOpenDepth?: number;
}) {
  return (
    <div>
      <Row node={node} depth={0} defaultOpenDepth={defaultOpenDepth} />
      <Reconcile node={node} />
    </div>
  );
}
