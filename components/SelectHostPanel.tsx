import React, { useState } from "react";
import { cn } from "../lib/utils";
import { useI18n } from "../application/i18n/I18nProvider";
import { Host, ProxyProfile, SSHKey } from "../types";
import { ManagedSource } from "../domain/models";
import { AsidePanel, type AsidePanelLayout } from "./ui/aside-panel";
import { SelectHostPanelContent } from "./SelectHostPanelContent";

interface SelectHostPanelProps {
  hosts: Host[];
  customGroups?: string[];
  selectedHostIds?: string[];
  multiSelect?: boolean;
  onSelect: (host: Host) => void;
  onSelectionChange?: (selectedHostIds: string[]) => void;
  onBack: () => void;
  onContinue?: () => void;
  onNewHost?: () => void;
  availableKeys?: SSHKey[];
  identities?: import('../domain/models').Identity[];
  proxyProfiles?: ProxyProfile[];
  managedSources?: ManagedSource[];
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
  title?: string;
  subtitle?: string;
  className?: string;
  width?: string;
  layout?: AsidePanelLayout;
  resizable?: boolean;
  persistWidthStorageKey?: string;
  resizeAriaLabel?: string;
  /** Allow saved local-shell (CMD/PowerShell/...) hosts as targets, e.g. snippet/script runners. */
  allowLocalHosts?: boolean;
}

const SelectHostPanel: React.FC<SelectHostPanelProps> = ({
  hosts,
  customGroups = [],
  selectedHostIds = [],
  multiSelect = false,
  onSelect,
  onSelectionChange,
  onBack,
  onContinue,
  onNewHost,
  availableKeys = [],
  identities = [],
  proxyProfiles = [],
  managedSources = [],
  onSaveHost,
  onCreateGroup,
  title,
  subtitle,
  className,
  width,
  layout = "overlay",
  resizable = false,
  persistWidthStorageKey,
  resizeAriaLabel,
  allowLocalHosts = false,
}) => {
  const { t } = useI18n();
  const [newHostPanelOpen, setNewHostPanelOpen] = useState(false);
  const panelTitle = title ?? t("selectHost.title");

  const handleConfirm = () => {
    if (onContinue) {
      onContinue();
      return;
    }
    const host = hosts
      .filter((entry) => entry.protocol !== "serial")
      .find((entry) => selectedHostIds.includes(entry.id));
    if (host) onSelect(host);
  };

  return (
    <AsidePanel
      open={true}
      onClose={onBack}
      title={panelTitle}
      subtitle={subtitle}
      showBackButton={true}
      onBack={onBack}
      className={cn(layout === "overlay" && "z-40", newHostPanelOpen && "overflow-visible", className)}
      width={width}
      layout={layout}
      resizable={resizable}
      persistWidthStorageKey={persistWidthStorageKey}
      resizeAriaLabel={resizeAriaLabel}
    >
      <SelectHostPanelContent
        hosts={hosts}
        customGroups={customGroups}
        selectedHostIds={selectedHostIds}
        multiSelect={multiSelect}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
        onConfirm={handleConfirm}
        onNewHost={onNewHost}
        availableKeys={availableKeys}
        identities={identities}
        proxyProfiles={proxyProfiles}
        managedSources={managedSources}
        onSaveHost={onSaveHost}
        onCreateGroup={onCreateGroup}
        onNewHostPanelOpenChange={setNewHostPanelOpen}
        allowLocalHosts={allowLocalHosts}
        className="flex-1 min-h-0"
      />
    </AsidePanel>
  );
};

export default SelectHostPanel;
