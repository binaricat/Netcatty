import {
  AlertTriangle,
  Check,
  ChevronDown,
  Globe,
  LayoutGrid,
  List as ListIcon,
  Search,
  Server,
  Shuffle,
  Zap,
} from "lucide-react";
import React, { useCallback, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { usePortForwardingState } from "../application/state/usePortForwardingState";
import {
  Host,
  PortForwardingRule,
  PortForwardingType,
  SSHKey,
} from "../domain/models";
import { cn } from "../lib/utils";
import SelectHostPanel from "./SelectHostPanel";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "./ui/aside-panel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { SortDropdown } from "./ui/sort-dropdown";
import { toast } from "./ui/toast";

// Import components and utilities from port-forwarding module
import {
  EditPanel,
  generateRuleLabel as buildRuleLabel,
  getTypeMenuLabel,
  NewFormPanel,
  RuleCard,
  WizardContent,
} from "./port-forwarding";

type WizardStep =
  | "type"
  | "local-config"
  | "remote-host-selection"
  | "remote-config"
  | "destination"
  | "host-selection"
  | "label";

interface PortForwardingProps {
  hosts: Host[];
  keys: SSHKey[];
  identities?: import('../domain/models').Identity[];
  customGroups: string[];
  onNewHost?: () => void;
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
}

const PortForwarding: React.FC<PortForwardingProps> = ({
  hosts,
  keys,
  identities = [],
  customGroups: _customGroups,
  onNewHost: _onNewHost,
  onSaveHost,
  onCreateGroup: _onCreateGroup,
}) => {
  const { t } = useI18n();
  const {
    rules: _rules,
    selectedRuleId,
    viewMode,
    sortMode,
    search,
    setSelectedRuleId,
    setViewMode,
    setSortMode,
    setSearch,
    addRule,
    updateRule,
    deleteRule,
    duplicateRule,
    setRuleStatus,
    startTunnel,
    stopTunnel,
    filteredRules,
    selectedRule: _selectedRule,
    preferFormMode,
    setPreferFormMode,
  } = usePortForwardingState();

  // Track connecting/stopping states
  const [pendingOperations, setPendingOperations] = useState<Set<string>>(
    new Set(),
  );

  // Start a port forwarding tunnel
  const handleStartTunnel = useCallback(
    async (rule: PortForwardingRule) => {
      const _host = hosts.find((h) => h.id === rule.hostId);
      if (!_host) {
        setRuleStatus(rule.id, "error", t("pf.error.hostNotFound"));
        toast.error(
          t("pf.error.hostNotFound"),
          t("pf.toast.titleWithLabel", { label: rule.label }),
        );
        return;
      }

      setPendingOperations((prev) => new Set([...prev, rule.id]));
      let errorShown = false;

      try {
        const result = await startTunnel(
          rule,
          _host,
          keys.map((k) => ({ id: k.id, privateKey: k.privateKey })),
          (status, error) => {
            // Show toast on error (only once)
            if (status === "error" && error && !errorShown) {
              errorShown = true;
              toast.error(
                error,
                t("pf.toast.titleWithLabel", { label: rule.label }),
              );
            }
          },
        );
        // Show error from result only if not already shown
        if (!result.success && result.error && !errorShown) {
          errorShown = true;
          toast.error(
            result.error,
            t("pf.toast.titleWithLabel", { label: rule.label }),
          );
        }
      } finally {
        setPendingOperations((prev) => {
          const next = new Set(prev);
          next.delete(rule.id);
          return next;
        });
      }
    },
    [hosts, keys, setRuleStatus, startTunnel, t],
  );

  // Stop a port forwarding tunnel
  const handleStopTunnel = useCallback(
    async (rule: PortForwardingRule) => {
      setPendingOperations((prev) => new Set([...prev, rule.id]));

      try {
        await stopTunnel(rule.id);
      } finally {
        setPendingOperations((prev) => {
          const next = new Set(prev);
          next.delete(rule.id);
          return next;
        });
      }
    },
    [stopTunnel],
  );

  // Wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>("type");
  const [wizardType, setWizardType] = useState<PortForwardingType>("local");
  const [draftRule, setDraftRule] = useState<Partial<PortForwardingRule>>({
    label: "",
    type: "local",
    localPort: undefined,
    bindAddress: "127.0.0.1",
    remoteHost: "",
    remotePort: undefined,
    hostId: undefined,
  });
  const [isEditing, setIsEditing] = useState(false);
  const [showHostSelector, setShowHostSelector] = useState(false);

  // Edit panel state (separate from wizard)
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [editingRule, setEditingRule] = useState<PortForwardingRule | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<Partial<PortForwardingRule>>({});

  // New forwarding form mode (skip wizard, all-in-one form)
  const [showNewForm, setShowNewForm] = useState(false);
  const [newFormDraft, setNewFormDraft] = useState<Partial<PortForwardingRule>>(
    {
      label: "",
      type: "local",
      localPort: undefined,
      bindAddress: "127.0.0.1",
      remoteHost: "",
      remotePort: undefined,
      hostId: undefined,
    },
  );

  // New forwarding menu
  const [showNewMenu, setShowNewMenu] = useState(false);

  // Delete confirmation dialog state for active tunnels
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<PortForwardingRule | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Reset wizard
  const resetWizard = () => {
    setWizardStep("type");
    setWizardType("local");
    setDraftRule({
      label: "",
      type: "local",
      localPort: undefined,
      bindAddress: "127.0.0.1",
      remoteHost: "",
      remotePort: undefined,
      hostId: undefined,
    });
    setIsEditing(false);
  };

  // Reset new form
  const resetNewForm = () => {
    setNewFormDraft({
      label: "",
      type: "local",
      localPort: undefined,
      bindAddress: "127.0.0.1",
      remoteHost: "",
      remotePort: undefined,
      hostId: undefined,
    });
  };

  // Start new rule - wizard or form based on user preference
  const startNewRule = (type: PortForwardingType) => {
    setShowNewMenu(false);

    if (preferFormMode) {
      // Form mode: show all-in-one form
      resetNewForm();
      setNewFormDraft((prev) => ({ ...prev, type }));
      setShowNewForm(true);
      setShowWizard(false);
    } else {
      // Wizard mode
      resetWizard();
      setWizardType(type);
      setDraftRule((prev) => ({ ...prev, type }));
      setShowWizard(true);
      setShowNewForm(false);
      setWizardStep("type");
    }
  };

  // Skip wizard and switch to form mode
  const skipWizardToForm = () => {
    // Save preference
    setPreferFormMode(true);

    // Transfer current draft to form
    setNewFormDraft({
      ...draftRule,
      type: wizardType,
    });
    setShowWizard(false);
    setShowNewForm(true);
  };

  // Open wizard from form
  const openWizardFromForm = () => {
    // User opens wizard - prefer wizard mode next time
    setPreferFormMode(false);

    // Transfer current form draft to wizard
    setWizardType(newFormDraft.type || "local");
    setDraftRule({ ...newFormDraft });
    setShowNewForm(false);
    setShowWizard(true);
    setWizardStep("type");
  };

  // Save new rule from form
  const saveNewFormRule = () => {
    const label =
      newFormDraft.label?.trim() ||
      (() => {
        // Host lookup reserved for future label enhancement (e.g., "Local:8080 → api.example.com:80 via server1")
        const _host = hosts.find((h) => h.id === newFormDraft.hostId);
        switch (newFormDraft.type) {
          case "local":
            return `Local:${newFormDraft.localPort} → ${newFormDraft.remoteHost}:${newFormDraft.remotePort}`;
          case "remote":
            return `Remote:${newFormDraft.localPort} → ${newFormDraft.remoteHost}:${newFormDraft.remotePort}`;
          case "dynamic":
            return `SOCKS:${newFormDraft.localPort}`;
          default:
            return "New Rule";
        }
      })();

    addRule({
      label,
      type: newFormDraft.type || "local",
      localPort: newFormDraft.localPort!,
      bindAddress: newFormDraft.bindAddress || "127.0.0.1",
      remoteHost: newFormDraft.remoteHost,
      remotePort: newFormDraft.remotePort,
      hostId: newFormDraft.hostId,
    });

    setShowNewForm(false);
    resetNewForm();
  };

  // Close new form
  const closeNewForm = () => {
    setShowNewForm(false);
    resetNewForm();
  };

  // Check if new form is valid
  const isNewFormValid = (): boolean => {
    if (
      !newFormDraft.localPort ||
      newFormDraft.localPort <= 0 ||
      newFormDraft.localPort >= 65536
    )
      return false;
    if (!newFormDraft.hostId) return false;
    if (newFormDraft.type !== "dynamic") {
      if (!newFormDraft.remoteHost || !newFormDraft.remotePort) return false;
    }
    return true;
  };

  // Edit existing rule - open edit panel
  const startEditRule = (rule: PortForwardingRule) => {
    setEditingRule(rule);
    setEditDraft({ ...rule });
    setShowEditPanel(true);
    setShowWizard(false);
    setShowNewForm(false);
  };

  // Save edited rule
  const saveEditedRule = () => {
    if (editingRule && editDraft.id) {
      updateRule(editDraft.id, editDraft);
      setShowEditPanel(false);
      setEditingRule(null);
      setEditDraft({});
    }
  };

  // Close edit panel
  const closeEditPanel = useCallback(() => {
    setShowEditPanel(false);
    setEditingRule(null);
    setEditDraft({});
    setSelectedRuleId(null);
  }, [setSelectedRuleId]);

  // Handle delete with confirmation for active tunnels
  const handleDeleteRule = useCallback(
    (rule: PortForwardingRule) => {
      // If tunnel is active or connecting, show confirmation dialog
      if (rule.status === "active" || rule.status === "connecting") {
        setRuleToDelete(rule);
        setShowDeleteConfirm(true);
      } else {
        // If inactive, delete directly
        if (editingRule?.id === rule.id) {
          closeEditPanel();
        }
        deleteRule(rule.id);
      }
    },
    [editingRule, deleteRule, closeEditPanel],
  );

  // Confirm delete of active tunnel: stop first, then delete
  const confirmDeleteActiveRule = useCallback(async () => {
    if (!ruleToDelete) return;

    setIsDeleting(true);
    try {
      // Stop the tunnel first
      await stopTunnel(ruleToDelete.id);
      // Then delete the rule
      if (editingRule?.id === ruleToDelete.id) {
        closeEditPanel();
      }
      deleteRule(ruleToDelete.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setRuleToDelete(null);
    }
  }, [ruleToDelete, stopTunnel, deleteRule, editingRule, closeEditPanel]);

  // Handle wizard navigation
  // Flow for local: type -> local-config -> destination -> host-selection
  // Flow for remote: type -> remote-host-selection (select host first) -> remote-config (port on remote) -> destination -> label
  // Flow for dynamic: type -> local-config -> host-selection
  const getNextStep = (): WizardStep | null => {
    switch (wizardStep) {
      case "type":
        if (wizardType === "dynamic") return "local-config";
        if (wizardType === "local") return "local-config";
        if (wizardType === "remote") return "remote-host-selection";
        return null;
      case "local-config":
        if (wizardType === "dynamic") return "host-selection";
        if (wizardType === "local") return "destination";
        return null;
      case "remote-host-selection":
        return "remote-config";
      case "remote-config":
        return "destination";
      case "destination":
        if (wizardType === "remote") return "label";
        return "host-selection"; // Host selection is last for local
      case "host-selection":
        return null;
      case "label":
        return null;
      default:
        return null;
    }
  };

  const getPrevStep = (): WizardStep | null => {
    switch (wizardStep) {
      case "type":
        return null;
      case "local-config":
        return "type";
      case "remote-host-selection":
        return "type";
      case "remote-config":
        return "remote-host-selection";
      case "destination":
        if (wizardType === "local") return "local-config";
        if (wizardType === "remote") return "remote-config";
        return null;
      case "host-selection":
        if (wizardType === "dynamic") return "local-config";
        return "destination";
      case "label":
        return "destination";
      default:
        return null;
    }
  };

  const canProceed = (): boolean => {
    switch (wizardStep) {
      case "type":
        // Type step just shows description, always can proceed
        return true;
      case "local-config":
        return !!(
          draftRule.localPort &&
          draftRule.localPort > 0 &&
          draftRule.localPort < 65536
        );
      case "remote-host-selection":
        return !!draftRule.hostId;
      case "remote-config":
        return !!(
          draftRule.localPort &&
          draftRule.localPort > 0 &&
          draftRule.localPort < 65536
        );
      case "destination":
        return !!(
          draftRule.remoteHost &&
          draftRule.remotePort &&
          draftRule.remotePort > 0
        );
      case "host-selection":
        return !!draftRule.hostId;
      case "label":
        return true; // Label is optional
      default:
        return false;
    }
  };

  const isLastStep = (): boolean => {
    return getNextStep() === null;
  };

  // Save rule
  const saveRule = () => {
    // Generate label if not provided
    const label = draftRule.label?.trim() || generateRuleLabel();

    if (isEditing && draftRule.id) {
      updateRule(draftRule.id, { ...draftRule, label });
    } else {
      addRule({
        label,
        type: wizardType,
        localPort: draftRule.localPort!,
        bindAddress: draftRule.bindAddress || "127.0.0.1",
        remoteHost: draftRule.remoteHost,
        remotePort: draftRule.remotePort,
        hostId: draftRule.hostId,
      });
    }

    setShowWizard(false);
    resetWizard();
  };

  const generateRuleLabel = (): string => {
    return buildRuleLabel(
      wizardType,
      draftRule.localPort,
      draftRule.remoteHost,
      draftRule.remotePort,
    );
  };

  // Handle skip wizard (just save with defaults)
  const _skipWizard = () => {
    setShowWizard(false);
    resetWizard();
  };

  // Render wizard panel content
  const hasRules = filteredRules.length > 0;

  return (
    <div className="flex h-full relative">
      {/* Main Content */}
      <div
        className={cn(
          "flex-1 flex flex-col min-h-0",
          showWizard || showEditPanel || showNewForm ? "mr-[360px]" : "",
        )}
      >
        {/* Toolbar */}
        <div className="h-14 px-4 flex items-center gap-3 bg-secondary/60 border-b border-border/60 relative z-20">
          <Dropdown open={showNewMenu} onOpenChange={setShowNewMenu}>
            <DropdownTrigger asChild>
              <Button variant="secondary" className="h-9 px-3 gap-2">
                <Zap size={14} />
                {t("pf.action.newForwarding")}
                <ChevronDown
                  size={14}
                  className={cn(
                    "transition-transform",
                    showNewMenu ? "rotate-180" : "",
                  )}
                />
              </Button>
            </DropdownTrigger>
            <DropdownContent className="w-max flex flex-col" align="start" sideOffset={8}>
              <Button
                variant="ghost"
                className="justify-start gap-3 h-10 px-3 whitespace-nowrap"
                onClick={() => startNewRule("local")}
              >
                <Globe size={16} className="text-blue-500" />
                {getTypeMenuLabel(t, "local")}
              </Button>
              <Button
                variant="ghost"
                className="justify-start gap-3 h-10 px-3 whitespace-nowrap"
                onClick={() => startNewRule("remote")}
              >
                <Server size={16} className="text-orange-500" />
                {getTypeMenuLabel(t, "remote")}
              </Button>
              <Button
                variant="ghost"
                className="justify-start gap-3 h-10 px-3 whitespace-nowrap"
                onClick={() => startNewRule("dynamic")}
              >
                <Shuffle size={16} className="text-purple-500" />
                {getTypeMenuLabel(t, "dynamic")}
              </Button>
            </DropdownContent>
          </Dropdown>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder={t("common.searchPlaceholder")}
                className="h-9 pl-8 w-44"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* View mode toggle */}
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9">
                  {viewMode === "grid" ? (
                    <LayoutGrid size={16} />
                  ) : (
                    <ListIcon size={16} />
                  )}
                  <ChevronDown size={10} className="ml-0.5" />
                </Button>
              </DropdownTrigger>
              <DropdownContent className="w-32" align="end">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 h-9"
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid size={14} /> {t("pf.view.grid")}
                  {viewMode === "grid" && (
                    <Check size={12} className="ml-auto" />
                  )}
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 h-9"
                  onClick={() => setViewMode("list")}
                >
                  <ListIcon size={14} /> {t("pf.view.list")}
                  {viewMode === "list" && (
                    <Check size={12} className="ml-auto" />
                  )}
                </Button>
              </DropdownContent>
            </Dropdown>

            {/* Sort mode toggle */}
            <SortDropdown
              value={sortMode}
              onChange={setSortMode}
              className="h-9 w-9"
            />
          </div>
        </div>

        {/* Rules List */}
        <div className="flex-1 overflow-auto p-4">
          {!hasRules ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <Zap size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {t("pf.empty.title")}
              </h3>
              <p className="text-sm text-center max-w-sm">
                {t("pf.empty.desc")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">{t("pf.title")}</h2>
                <span className="text-xs text-muted-foreground">
                  {t("pf.rulesCount", { count: filteredRules.length })}
                </span>
              </div>

              <div
                className={cn(
                  viewMode === "grid"
                    ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                    : "flex flex-col gap-2.5",
                )}
              >
                {filteredRules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    viewMode={viewMode}
                    isSelected={selectedRuleId === rule.id}
                    isPending={pendingOperations.has(rule.id)}
                    onSelect={() => {
                      setSelectedRuleId(rule.id);
                      startEditRule(rule);
                    }}
                    onEdit={() => startEditRule(rule)}
                    onDuplicate={() => duplicateRule(rule.id)}
                    onDelete={() => handleDeleteRule(rule)}
                    onStart={() => handleStartTunnel(rule)}
                    onStop={() => handleStopTunnel(rule)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Edit Panel - shown when a rule is selected */}
      {showEditPanel && editingRule && (
        <EditPanel
          rule={editingRule}
          draft={editDraft}
          hosts={hosts}
          onDraftChange={(updates) =>
            setEditDraft((prev) => ({ ...prev, ...updates }))
          }
          onSave={saveEditedRule}
          onClose={closeEditPanel}
          onDuplicate={() => {
            duplicateRule(editingRule.id);
            closeEditPanel();
          }}
          onDelete={() => handleDeleteRule(editingRule)}
          onOpenHostSelector={() => setShowHostSelector(true)}
        />
      )}

      {/* Wizard Panel */}
      {showWizard && (
        <AsidePanel
          open={true}
          onClose={() => {
            setShowWizard(false);
            resetWizard();
          }}
          title={isEditing ? t("pf.wizard.editTitle") : t("pf.wizard.newTitle")}
          width="w-[360px]"
          showBackButton={!!getPrevStep()}
          onBack={
            getPrevStep()
              ? () => {
                const prev = getPrevStep();
                if (prev) setWizardStep(prev);
              }
              : undefined
          }
        >
          <AsidePanelContent>
            <WizardContent
              step={wizardStep}
              type={wizardType}
              draft={draftRule}
              hosts={hosts}
              onTypeChange={(type) => {
                setWizardType(type);
                setDraftRule((prev) => ({ ...prev, type }));
              }}
              onDraftChange={(updates) =>
                setDraftRule((prev) => ({ ...prev, ...updates }))
              }
              onOpenHostSelector={() => setShowHostSelector(true)}
            />
          </AsidePanelContent>
          <AsidePanelFooter className="space-y-2">
            <Button
              className="w-full h-10"
              disabled={!canProceed()}
              onClick={() => {
                if (isLastStep()) {
                  saveRule();
                } else {
                  const next = getNextStep();
                  if (next) setWizardStep(next);
                }
              }}
            >
              {isLastStep()
                ? isEditing
                  ? t("pf.wizard.saveChanges")
                  : t("pf.wizard.done")
                : t("pf.wizard.continue")}
            </Button>
            <Button
              variant="ghost"
              className="w-full h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              onClick={() => {
                if (isEditing) {
                  setShowWizard(false);
                  resetWizard();
                } else {
                  skipWizardToForm();
                }
              }}
            >
              {isEditing ? t("pf.wizard.cancel") : t("pf.wizard.skipWizard")}
            </Button>
          </AsidePanelFooter>
        </AsidePanel>
      )}

      {/* Host Selector Overlay */}
      {showHostSelector && (
        <SelectHostPanel
          hosts={hosts}
          customGroups={_customGroups}
          selectedHostIds={
            showEditPanel
              ? editDraft.hostId
                ? [editDraft.hostId]
                : []
              : showNewForm
                ? newFormDraft.hostId
                  ? [newFormDraft.hostId]
                  : []
                : draftRule.hostId
                  ? [draftRule.hostId]
                  : []
          }
          multiSelect={false}
          onSelect={(host) => {
            if (showEditPanel) {
              setEditDraft((prev) => ({ ...prev, hostId: host.id }));
            } else if (showNewForm) {
              setNewFormDraft((prev) => ({ ...prev, hostId: host.id }));
            } else {
              setDraftRule((prev) => ({ ...prev, hostId: host.id }));
            }
            setShowHostSelector(false);
          }}
          onBack={() => setShowHostSelector(false)}
          onContinue={() => setShowHostSelector(false)}
          availableKeys={keys}
          identities={identities}
          onSaveHost={onSaveHost}
          onCreateGroup={_onCreateGroup}
        />
      )}

      {/* New Form Panel (skip wizard mode) */}
      {showNewForm && (
        <NewFormPanel
          draft={newFormDraft}
          hosts={hosts}
          onDraftChange={(updates) =>
            setNewFormDraft((prev) => ({ ...prev, ...updates }))
          }
          onSave={saveNewFormRule}
          onClose={closeNewForm}
          onOpenHostSelector={() => setShowHostSelector(true)}
          onOpenWizard={openWizardFromForm}
          isValid={isNewFormValid()}
        />
      )}

      {/* Delete Active Tunnel Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={(open) => {
        if (!isDeleting) {
          setShowDeleteConfirm(open);
          if (!open) setRuleToDelete(null);
        }
      }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle size={20} />
              {t("pf.deleteActive.title")}
            </DialogTitle>
            <DialogDescription>
              {t("pf.deleteActive.desc", { label: ruleToDelete?.label ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteConfirm(false);
                setRuleToDelete(null);
              }}
              disabled={isDeleting}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteActiveRule}
              disabled={isDeleting}
            >
              {t("pf.deleteActive.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PortForwarding;
