import { FileCode, FileText, X } from "lucide-react";
import React from "react";

import { useEditorTabDirty, type EditorTabChrome } from "../../application/state/editorTabStore";
import { cn } from "../../lib/utils";

const CODE_EXTENSIONS_RE = /\.(js|jsx|ts|tsx|py|rb|go|rs|c|cpp|cs|java|php|sh|bash|zsh|fish|lua|r|scala|swift|kt|html|css|scss|less|json|yaml|yml|toml|xml|sql|graphql|gql|md|mdx|conf|ini|env|tf|hcl|dockerfile)$/i;

export interface EditorWindowTabBarProps {
  tabs: readonly EditorTabChrome[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export const EditorWindowTabBar: React.FC<EditorWindowTabBarProps> = ({
  tabs,
  activeTabId,
  onSelect,
  onClose,
}) => {
  const fileNameCounts = new Map<string, number>();
  for (const tab of tabs) {
    fileNameCounts.set(tab.fileName, (fileNameCounts.get(tab.fileName) ?? 0) + 1);
  }

  return (
    <div className="flex h-8 min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1">
      {tabs.map((tab) => (
        <EditorWindowTab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          suffix={
            (fileNameCounts.get(tab.fileName) ?? 0) > 1
              ? ` · ${tab.hostLabel || tab.hostId}`
              : ""
          }
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </div>
  );
};

const EditorWindowTab: React.FC<{
  tab: EditorTabChrome;
  isActive: boolean;
  suffix: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}> = ({ tab, isActive, suffix, onSelect, onClose }) => {
  const dirty = useEditorTabDirty(tab.id);
  const FileIcon = CODE_EXTENSIONS_RE.test(tab.fileName) ? FileCode : FileText;
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.id)}
      className={cn(
        "app-no-drag group relative flex h-7 max-w-[220px] min-w-[120px] items-center gap-1.5 rounded-t-md px-2.5 text-xs font-semibold",
        isActive ? "bg-background text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <FileIcon size={13} className="shrink-0" />
      <span className="truncate">
        {dirty && <span className="mr-0.5 text-primary">●</span>}
        {tab.fileName}
        {suffix}
      </span>
      <span
        role="button"
        tabIndex={-1}
        className="ml-auto rounded-full p-0.5 opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.id);
        }}
      >
        <X size={11} />
      </span>
    </button>
  );
};
