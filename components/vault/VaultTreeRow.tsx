import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";

type VaultTreeInlineRenameInputProps = {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export const VaultTreeInlineRenameInput: React.FC<VaultTreeInlineRenameInputProps> = ({
  initialName,
  onCommit,
  onCancel,
  className,
  style,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const committedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      data-vault-tree-inline-edit="true"
      data-inline-group-edit="true"
      value={value}
      draggable={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        queueMicrotask(() => {
          commit();
        });
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      className={cn(
        "min-w-0 flex-1 truncate select-text rounded-sm border border-primary/50 bg-background/80 px-1 py-0 text-sm font-medium outline-none ring-1 ring-primary/30",
        className,
      )}
      style={style}
    />
  );
};

type VaultTreeGroupRowProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  name: string;
  depth: number;
  expanded?: boolean;
  selected?: boolean;
  count?: number;
  hasChildren?: boolean;
  editing?: boolean;
  editingInitialName?: string;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
  actions?: React.ReactNode;
  labelActions?: React.ReactNode;
  icon?: React.ReactNode;
  iconSize?: number;
  meta?: React.ReactNode;
  rowRef?: React.Ref<HTMLDivElement>;
  onToggle?: () => void;
};

export const VaultTreeGroupRow: React.FC<VaultTreeGroupRowProps> = ({
  name,
  depth,
  expanded = false,
  selected = false,
  count,
  hasChildren,
  editing = false,
  editingInitialName,
  onRenameCommit,
  onRenameCancel,
  actions,
  labelActions,
  icon,
  iconSize = 18,
  meta,
  rowRef,
  className,
  style,
  ...props
}) => {
  const canExpand = hasChildren ?? Boolean(count);

  return (
    <div
      ref={rowRef}
      className={cn(
        "vault-drop-indicator-row group flex h-7 min-w-0 items-center px-2 text-sm font-medium cursor-pointer transition-colors select-none rounded-md",
        selected
          ? "bg-secondary text-foreground"
          : "hover:bg-secondary/60",
        className,
      )}
      style={{ paddingLeft: depth * 16 + 4, ...style }}
      data-vault-tree-row="group"
      data-selected={selected ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      {...props}
    >
      <div className="mr-1 flex h-5 w-4 flex-shrink-0 items-center justify-center text-muted-foreground">
        {canExpand && (
          <div className={cn("transition-transform duration-200", expanded ? "rotate-90" : "")}>
            <ChevronRight size={14} />
          </div>
        )}
      </div>
      <div className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center text-current transition-colors">
        {icon ?? (expanded ? (
          <FolderOpen size={iconSize} strokeWidth={1.9} />
        ) : (
          <Folder size={iconSize} strokeWidth={1.9} />
        ))}
      </div>
      {editing && onRenameCommit && onRenameCancel ? (
        <VaultTreeInlineRenameInput
          initialName={editingInitialName ?? name}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          className="flex-1 font-semibold"
        />
      ) : (
        <span className="flex h-5 min-w-0 flex-1 translate-y-px items-center gap-1.5 leading-none">
          <span className="min-w-0 truncate">{name}</span>
          {labelActions}
        </span>
      )}
      {meta}
      {typeof count === "number" && count > 0 && (
        <span className="shrink-0 rounded-full border border-border bg-background/50 px-1.5 py-0 text-[10px] opacity-70">
          {count}
        </span>
      )}
      {actions}
    </div>
  );
};

type VaultTreeItemRowProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  label: string;
  depth: number;
  selected?: boolean;
  icon?: React.ReactNode;
  leading?: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  editing?: boolean;
  editingInitialName?: string;
  onRenameCommit?: (name: string) => void;
  onRenameCancel?: () => void;
  content?: React.ReactNode;
};

export const VaultTreeItemRow: React.FC<VaultTreeItemRowProps> = ({
  label,
  depth,
  selected = false,
  icon,
  leading,
  detail,
  actions,
  editing = false,
  editingInitialName,
  onRenameCommit,
  onRenameCancel,
  content,
  className,
  style,
  ...props
}) => (
  <div
    className={cn(
      "vault-drop-indicator-row group flex h-7 min-w-0 items-center px-2 text-sm cursor-pointer transition-colors select-none rounded-md",
      selected
        ? "bg-secondary text-foreground"
        : "hover:bg-secondary/40",
      className,
    )}
    style={{ paddingLeft: depth * 16 + 4, ...style }}
    data-vault-tree-row="item"
    data-selected={selected ? "true" : "false"}
    {...props}
  >
    {leading ?? <div className="mr-1 h-5 w-4 flex-shrink-0" />}
    {icon ? <div className="mr-2 flex shrink-0 items-center self-center">{icon}</div> : <FileText size={14} className="mr-2 shrink-0 text-muted-foreground" />}
    {content ?? (
      <div className="min-w-0 flex-1">
        {editing && onRenameCommit && onRenameCancel ? (
          <VaultTreeInlineRenameInput
            initialName={editingInitialName ?? label}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <div className="flex min-w-0 items-center truncate leading-none">{label}</div>
        )}
        {detail && <div className="truncate text-xs text-muted-foreground">{detail}</div>}
      </div>
    )}
    {actions}
  </div>
);
