"use client";

import { useState } from "react";
import type { Deal } from "@/lib/realestate/deals";
import { inputCls, cx } from "@/components/ui";
import { IconPlus, IconChevronDown } from "@/components/icons";

function MenuItem({
  children,
  onClick,
  danger,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover",
        danger ? "text-red" : "text-txt",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function DealSwitcher({
  deals,
  currentId,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  deals: Deal[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const current = deals.find((d) => d.id === currentId) ?? deals[0];
  const [menu, setMenu] = useState(false);
  const close = () => setMenu(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* deal name as an editable title — borderless until hover/focus */}
      <input
        value={current?.name ?? ""}
        onChange={(e) => onRename(e.target.value)}
        aria-label="Deal name"
        className="min-w-0 max-w-[280px] rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1 text-[22px] font-semibold tracking-tight text-txt outline-none transition-colors hover:border-line focus:border-line-strong focus:bg-surface"
      />

      {deals.length > 1 && (
        <select
          value={currentId}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="Switch deal"
          className={cx(inputCls, "max-w-[170px]")}
        >
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}

      {/* rare deal actions tucked into a popover */}
      <div className="relative">
        <button
          onClick={() => setMenu((v) => !v)}
          aria-label="Deal actions"
          aria-expanded={menu}
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] border border-line bg-elevated text-mut transition-colors hover:bg-hover hover:text-txt"
        >
          <IconChevronDown size={15} />
        </button>
        {menu && (
          <>
            <button className="fixed inset-0 z-30 cursor-default" aria-hidden tabIndex={-1} onClick={close} />
            <div className="absolute left-0 z-40 mt-1.5 w-40 rounded-[var(--radius-sm)] border border-line bg-elevated p-1 shadow-[var(--shadow-lg)]">
              <MenuItem icon={<IconPlus size={14} />} onClick={() => { onCreate(); close(); }}>
                New deal
              </MenuItem>
              <MenuItem onClick={() => { onDuplicate(); close(); }}>Duplicate</MenuItem>
              <MenuItem danger onClick={() => { onDelete(); close(); }}>Delete</MenuItem>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
