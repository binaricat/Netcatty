import React, { useCallback, useMemo, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    ArrowRightLeft,
    ChevronDown,
    Copy,
    LayoutGrid,
    List as ListIcon,
    Loader2,
    MoreVertical,
    Play,
    Plus,
    Search,
    Square,
    Trash2,
    Pencil,
    Zap,
    Globe,
    Server,
    Shuffle,
    SortAsc,
    SortDesc,
    Calendar,
    CalendarClock,
    Check,
} from 'lucide-react';
import { PortForwardingRule, PortForwardingType, Host, SSHKey } from '../domain/models';
import { Button } from './ui/button';
import { AsidePanel, AsidePanelContent, AsidePanelFooter, AsideActionMenu, AsideActionMenuItem } from './ui/aside-panel';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent } from './ui/card';
import { Dropdown, DropdownTrigger, DropdownContent } from './ui/dropdown';
import { SortDropdown } from './ui/sort-dropdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { cn } from '../lib/utils';
import { TrafficDiagram } from './TrafficDiagram';
import { DistroAvatar } from './DistroAvatar';
import SelectHostPanel from './SelectHostPanel';
import {
    usePortForwardingState,
    ViewMode,
    SortMode
} from '../application/state/usePortForwardingState';
import {
    startPortForward,
    stopPortForward,
    isBackendAvailable,
} from '../infrastructure/services/portForwardingService';
import { toast } from './ui/toast';

type WizardStep = 'type' | 'local-config' | 'remote-host-selection' | 'remote-config' | 'destination' | 'host-selection' | 'label';

interface PortForwardingProps {
    hosts: Host[];
    keys: SSHKey[];
    customGroups: string[];
    onNewHost?: () => void;
    onSaveHost?: (host: Host) => void;
    onCreateGroup?: (groupPath: string) => void;
}

const TYPE_LABELS: Record<PortForwardingType, string> = {
    local: 'Local Forwarding',
    remote: 'Remote Forwarding',
    dynamic: 'Dynamic Forwarding',
};

const TYPE_DESCRIPTIONS: Record<PortForwardingType, string> = {
    local: 'Local forwarding lets you access a remote server\'s listening port as though it were local.',
    remote: 'Remote forwarding opens a port on the remote machine and forwards connections to the local (current) host.',
    dynamic: 'Dynamic port forwarding turns Netcatty into a SOCKS proxy server. SOCKS proxy server is a protocol to request any connection via a remote host.',
};

const TYPE_ICONS: Record<PortForwardingType, React.ReactNode> = {
    local: <Globe size={16} />,
    remote: <Server size={16} />,
    dynamic: <Shuffle size={16} />,
};

const PortForwarding: React.FC<PortForwardingProps> = ({ hosts, keys, customGroups, onNewHost, onSaveHost, onCreateGroup }) => {
    const {
        rules,
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
        filteredRules,
        selectedRule,
    } = usePortForwardingState();

    // Track connecting/stopping states
    const [pendingOperations, setPendingOperations] = useState<Set<string>>(new Set());

    // Start a port forwarding tunnel
    const handleStartTunnel = useCallback(async (rule: PortForwardingRule) => {
        const host = hosts.find(h => h.id === rule.hostId);
        if (!host) {
            setRuleStatus(rule.id, 'error', 'Host not found');
            toast.error('Host not found', `Port Forwarding: ${rule.label}`);
            return;
        }

        setPendingOperations(prev => new Set([...prev, rule.id]));
        let errorShown = false;

        try {
            const result = await startPortForward(
                rule,
                host,
                keys.map(k => ({ id: k.id, privateKey: k.privateKey })),
                (status, error) => {
                    setRuleStatus(rule.id, status, error);
                    // Show toast on error (only once)
                    if (status === 'error' && error && !errorShown) {
                        errorShown = true;
                        toast.error(error, `Port Forwarding: ${rule.label}`);
                    }
                }
            );
            // Show error from result only if not already shown
            if (!result.success && result.error && !errorShown) {
                errorShown = true;
                toast.error(result.error, `Port Forwarding: ${rule.label}`);
            }
        } finally {
            setPendingOperations(prev => {
                const next = new Set(prev);
                next.delete(rule.id);
                return next;
            });
        }
    }, [hosts, keys, setRuleStatus]);

    // Stop a port forwarding tunnel
    const handleStopTunnel = useCallback(async (rule: PortForwardingRule) => {
        setPendingOperations(prev => new Set([...prev, rule.id]));

        try {
            await stopPortForward(rule.id, (status) => {
                setRuleStatus(rule.id, status);
            });
        } finally {
            setPendingOperations(prev => {
                const next = new Set(prev);
                next.delete(rule.id);
                return next;
            });
        }
    }, [setRuleStatus]);


    // Wizard state
    const [showWizard, setShowWizard] = useState(false);
    const [wizardStep, setWizardStep] = useState<WizardStep>('type');
    const [wizardType, setWizardType] = useState<PortForwardingType>('local');
    const [draftRule, setDraftRule] = useState<Partial<PortForwardingRule>>({
        label: '',
        type: 'local',
        localPort: undefined,
        bindAddress: '127.0.0.1',
        remoteHost: '',
        remotePort: undefined,
        hostId: undefined,
    });
    const [isEditing, setIsEditing] = useState(false);
    const [showHostSelector, setShowHostSelector] = useState(false);

    // Edit panel state (separate from wizard)
    const [showEditPanel, setShowEditPanel] = useState(false);
    const [editingRule, setEditingRule] = useState<PortForwardingRule | null>(null);
    const [editDraft, setEditDraft] = useState<Partial<PortForwardingRule>>({});

    // New forwarding form mode (skip wizard, all-in-one form)
    const [showNewForm, setShowNewForm] = useState(false);
    const [newFormDraft, setNewFormDraft] = useState<Partial<PortForwardingRule>>({
        label: '',
        type: 'local',
        localPort: undefined,
        bindAddress: '127.0.0.1',
        remoteHost: '',
        remotePort: undefined,
        hostId: undefined,
    });
    // User preference: prefer wizard (false) or form (true)
    const [preferFormMode, setPreferFormMode] = useState(() => {
        try {
            // Default to wizard mode (false) if not set
            return localStorage.getItem('pf-prefer-form-mode') === 'true';
        } catch {
            return false;
        }
    });

    // New forwarding menu
    const [showNewMenu, setShowNewMenu] = useState(false);

    // Reset wizard
    const resetWizard = () => {
        setWizardStep('type');
        setWizardType('local');
        setDraftRule({
            label: '',
            type: 'local',
            localPort: undefined,
            bindAddress: '127.0.0.1',
            remoteHost: '',
            remotePort: undefined,
            hostId: undefined,
        });
        setIsEditing(false);
    };

    // Reset new form
    const resetNewForm = () => {
        setNewFormDraft({
            label: '',
            type: 'local',
            localPort: undefined,
            bindAddress: '127.0.0.1',
            remoteHost: '',
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
            setNewFormDraft(prev => ({ ...prev, type }));
            setShowNewForm(true);
            setShowWizard(false);
        } else {
            // Wizard mode
            resetWizard();
            setWizardType(type);
            setDraftRule(prev => ({ ...prev, type }));
            setShowWizard(true);
            setShowNewForm(false);
            setWizardStep('type');
        }
    };

    // Skip wizard and switch to form mode
    const skipWizardToForm = () => {
        // Save preference
        setPreferFormMode(true);
        try {
            localStorage.setItem('pf-prefer-form-mode', 'true');
        } catch { }

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
        try {
            localStorage.setItem('pf-prefer-form-mode', 'false');
        } catch { }

        // Transfer current form draft to wizard
        setWizardType(newFormDraft.type || 'local');
        setDraftRule({ ...newFormDraft });
        setShowNewForm(false);
        setShowWizard(true);
        setWizardStep('type');
    };

    // Save new rule from form
    const saveNewFormRule = () => {
        const label = newFormDraft.label?.trim() || (() => {
            const host = hosts.find(h => h.id === newFormDraft.hostId);
            switch (newFormDraft.type) {
                case 'local':
                    return `Local:${newFormDraft.localPort} → ${newFormDraft.remoteHost}:${newFormDraft.remotePort}`;
                case 'remote':
                    return `Remote:${newFormDraft.localPort} → ${newFormDraft.remoteHost}:${newFormDraft.remotePort}`;
                case 'dynamic':
                    return `SOCKS:${newFormDraft.localPort}`;
                default:
                    return 'New Rule';
            }
        })();

        addRule({
            label,
            type: newFormDraft.type || 'local',
            localPort: newFormDraft.localPort!,
            bindAddress: newFormDraft.bindAddress || '127.0.0.1',
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
        if (!newFormDraft.localPort || newFormDraft.localPort <= 0 || newFormDraft.localPort >= 65536) return false;
        if (!newFormDraft.hostId) return false;
        if (newFormDraft.type !== 'dynamic') {
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
    const closeEditPanel = () => {
        setShowEditPanel(false);
        setEditingRule(null);
        setEditDraft({});
        setSelectedRuleId(null);
    };

    // Handle wizard navigation
    // Flow for local: type -> local-config -> destination -> host-selection
    // Flow for remote: type -> remote-host-selection (select host first) -> remote-config (port on remote) -> destination -> label
    // Flow for dynamic: type -> local-config -> host-selection
    const getNextStep = (): WizardStep | null => {
        switch (wizardStep) {
            case 'type':
                if (wizardType === 'dynamic') return 'local-config';
                if (wizardType === 'local') return 'local-config';
                if (wizardType === 'remote') return 'remote-host-selection';
                return null;
            case 'local-config':
                if (wizardType === 'dynamic') return 'host-selection';
                if (wizardType === 'local') return 'destination';
                return null;
            case 'remote-host-selection':
                return 'remote-config';
            case 'remote-config':
                return 'destination';
            case 'destination':
                if (wizardType === 'remote') return 'label';
                return 'host-selection'; // Host selection is last for local
            case 'host-selection':
                return null;
            case 'label':
                return null;
            default:
                return null;
        }
    };

    const getPrevStep = (): WizardStep | null => {
        switch (wizardStep) {
            case 'type':
                return null;
            case 'local-config':
                return 'type';
            case 'remote-host-selection':
                return 'type';
            case 'remote-config':
                return 'remote-host-selection';
            case 'destination':
                if (wizardType === 'local') return 'local-config';
                if (wizardType === 'remote') return 'remote-config';
                return null;
            case 'host-selection':
                if (wizardType === 'dynamic') return 'local-config';
                return 'destination';
            case 'label':
                return 'destination';
            default:
                return null;
        }
    };

    const canProceed = (): boolean => {
        switch (wizardStep) {
            case 'type':
                // Type step just shows description, always can proceed
                return true;
            case 'local-config':
                return !!(draftRule.localPort && draftRule.localPort > 0 && draftRule.localPort < 65536);
            case 'remote-host-selection':
                return !!draftRule.hostId;
            case 'remote-config':
                return !!(draftRule.localPort && draftRule.localPort > 0 && draftRule.localPort < 65536);
            case 'destination':
                return !!(draftRule.remoteHost && draftRule.remotePort && draftRule.remotePort > 0);
            case 'host-selection':
                return !!draftRule.hostId;
            case 'label':
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
                bindAddress: draftRule.bindAddress || '127.0.0.1',
                remoteHost: draftRule.remoteHost,
                remotePort: draftRule.remotePort,
                hostId: draftRule.hostId,
            });
        }

        setShowWizard(false);
        resetWizard();
    };

    const generateRuleLabel = (): string => {
        const host = hosts.find(h => h.id === draftRule.hostId);
        const hostLabel = host?.label || 'Unknown';

        switch (wizardType) {
            case 'local':
                return `Local:${draftRule.localPort} → ${draftRule.remoteHost}:${draftRule.remotePort}`;
            case 'remote':
                return `Remote:${draftRule.localPort} → ${draftRule.remoteHost}:${draftRule.remotePort}`;
            case 'dynamic':
                return `SOCKS:${draftRule.localPort}`;
            default:
                return 'New Rule';
        }
    };

    // Handle skip wizard (just save with defaults)
    const skipWizard = () => {
        setShowWizard(false);
        resetWizard();
    };

    // Render rule card
    const renderRuleCard = (rule: PortForwardingRule) => {
        const isSelected = selectedRuleId === rule.id;

        return (
            <ContextMenu key={rule.id}>
                <ContextMenuTrigger>
                    <div
                        className={cn(
                            "group cursor-pointer",
                            viewMode === 'grid'
                                ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                            isSelected && "ring-2 ring-primary"
                        )}
                        onClick={() => {
                            setSelectedRuleId(rule.id);
                            startEditRule(rule);
                        }}
                    >
                        <div className="flex items-center gap-3 h-full">
                            <div className={cn(
                                "h-11 w-11 rounded-xl flex items-center justify-center text-sm font-bold transition-colors",
                                rule.status === 'active' ? (
                                    rule.type === 'local' ? "bg-blue-500 text-white" :
                                        rule.type === 'remote' ? "bg-orange-500 text-white" :
                                            "bg-purple-500 text-white"
                                ) : (
                                    rule.type === 'local' ? "bg-blue-500/15 text-blue-500" :
                                        rule.type === 'remote' ? "bg-orange-500/15 text-orange-500" :
                                            "bg-purple-500/15 text-purple-500"
                                )
                            )}>
                                {rule.type[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold truncate">{rule.label}</span>
                                    <span
                                        className={cn(
                                            "h-2 w-2 rounded-full flex-shrink-0",
                                            rule.status === 'active' ? "bg-emerald-500" :
                                                rule.status === 'connecting' ? "bg-yellow-500 animate-pulse" :
                                                    rule.status === 'error' ? "bg-red-500" :
                                                        "bg-muted-foreground/40"
                                        )}
                                        title={rule.status === 'error' && rule.error ? rule.error : undefined}
                                    />
                                </div>
                                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                    <span className="truncate">
                                        {rule.type === 'dynamic'
                                            ? `SOCKS on ${rule.bindAddress}:${rule.localPort}`
                                            : `${rule.bindAddress}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`
                                        }
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {pendingOperations.has(rule.id) ? (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        disabled
                                    >
                                        <Loader2 size={12} className="animate-spin" />
                                    </Button>
                                ) : rule.status === 'inactive' || rule.status === 'error' ? (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleStartTunnel(rule);
                                        }}
                                    >
                                        <Play size={12} />
                                    </Button>
                                ) : rule.status === 'active' || rule.status === 'connecting' ? (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleStopTunnel(rule);
                                        }}
                                    >
                                        <Square size={12} />
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onClick={() => startEditRule(rule)}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => duplicateRule(rule.id)}>
                        <Copy className="mr-2 h-4 w-4" /> Duplicate
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {(rule.status === 'inactive' || rule.status === 'error') && (
                        <ContextMenuItem onClick={() => handleStartTunnel(rule)}>
                            <Play className="mr-2 h-4 w-4" /> Start
                        </ContextMenuItem>
                    )}
                    {(rule.status === 'active' || rule.status === 'connecting') && (
                        <ContextMenuItem onClick={() => handleStopTunnel(rule)}>
                            <Square className="mr-2 h-4 w-4" /> Stop
                        </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem className="text-destructive" onClick={() => {
                        // Close edit panel if deleting the currently editing rule
                        if (editingRule?.id === rule.id) {
                            closeEditPanel();
                        }
                        deleteRule(rule.id);
                    }}>
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        );
    };

    // Render wizard panel content
    const renderWizardContent = () => {
        const selectedHost = hosts.find(h => h.id === draftRule.hostId);

        switch (wizardStep) {
            case 'type':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Select the port forwarding type:</div>
                        <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
                            {(['local', 'remote', 'dynamic'] as PortForwardingType[]).map((type) => (
                                <Button
                                    key={type}
                                    variant={wizardType === type ? 'default' : 'ghost'}
                                    size="sm"
                                    className={cn(
                                        "flex-1 h-9",
                                        wizardType === type ? "bg-primary text-primary-foreground" : ""
                                    )}
                                    onClick={() => {
                                        setWizardType(type);
                                        setDraftRule(prev => ({ ...prev, type }));
                                    }}
                                >
                                    {type[0].toUpperCase() + type.slice(1)}
                                </Button>
                            ))}
                        </div>

                        <div className="mt-6">
                            <TrafficDiagram type={wizardType} isAnimating={true} />
                        </div>

                        <p className="text-sm text-muted-foreground mt-4 leading-relaxed">
                            {TYPE_DESCRIPTIONS[wizardType]}
                        </p>
                    </>
                );

            case 'local-config':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Set the local port and binding address:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} highlightRole="app" />

                        <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                            This port will be open on the local (current) device, and it will receive the traffic.
                        </p>

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-xs">Local port number *</Label>
                                <Input
                                    type="number"
                                    placeholder="e.g. 8080"
                                    className="h-10"
                                    value={draftRule.localPort || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, localPort: parseInt(e.target.value) || undefined }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs">Bind address</Label>
                                <Input
                                    placeholder="127.0.0.1"
                                    className="h-10"
                                    value={draftRule.bindAddress || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, bindAddress: e.target.value }))}
                                />
                            </div>
                        </div>
                    </>
                );

            case 'remote-host-selection':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Select the remote host:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} highlightRole="ssh-server" />

                        <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                            Select a host where the port will be open. The traffic from this port will be forwarded to the destination host.
                        </p>

                        <Button
                            variant="default"
                            className="w-full h-11"
                            onClick={() => setShowHostSelector(true)}
                        >
                            {selectedHost ? (
                                <div className="flex items-center gap-2 w-full">
                                    <DistroAvatar host={selectedHost} fallback={selectedHost.os[0].toUpperCase()} className="h-6 w-6" />
                                    <span>{selectedHost.label}</span>
                                    <Check size={14} className="ml-auto" />
                                </div>
                            ) : (
                                'Select a host'
                            )}
                        </Button>
                    </>
                );

            case 'remote-config':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Set the port and binding address:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} highlightRole="ssh-server" />

                        <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                            We will forward traffic from specified port and interface address of the selected host.
                        </p>

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-xs">Remote port number *</Label>
                                <Input
                                    type="number"
                                    placeholder="e.g. 8080"
                                    className="h-10"
                                    value={draftRule.localPort || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, localPort: parseInt(e.target.value) || undefined }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs">Bind address</Label>
                                <Input
                                    placeholder="127.0.0.1"
                                    className="h-10"
                                    value={draftRule.bindAddress || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, bindAddress: e.target.value }))}
                                />
                            </div>
                        </div>
                    </>
                );

            case 'destination':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Select the destination host:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} highlightRole="target" />

                        <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                            {wizardType === 'local'
                                ? 'Enter the remote destination that you want to access through the tunnel.'
                                : 'The destination address and port where the traffic will be forwarded.'
                            }
                        </p>

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-xs">Destination address *</Label>
                                <Input
                                    placeholder="e.g. 127.0.0.1 or 192.168.1.100"
                                    className="h-10"
                                    value={draftRule.remoteHost || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, remoteHost: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs">Destination port number *</Label>
                                <Input
                                    type="number"
                                    placeholder="e.g. 3306"
                                    className="h-10"
                                    value={draftRule.remotePort || ''}
                                    onChange={e => setDraftRule(prev => ({ ...prev, remotePort: parseInt(e.target.value) || undefined }))}
                                />
                            </div>
                        </div>
                    </>
                );

            case 'host-selection':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Select the SSH server:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} highlightRole="ssh-server" />

                        <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                            {wizardType === 'dynamic'
                                ? 'Select the SSH server that will act as your SOCKS proxy.'
                                : 'Select the SSH server that will tunnel your traffic to the destination.'
                            }
                        </p>

                        <Button
                            variant="default"
                            className="w-full h-11"
                            onClick={() => setShowHostSelector(true)}
                        >
                            {selectedHost ? (
                                <div className="flex items-center gap-2 w-full">
                                    <DistroAvatar host={selectedHost} fallback={selectedHost.os[0].toUpperCase()} className="h-6 w-6" />
                                    <span>{selectedHost.label}</span>
                                    <Check size={14} className="ml-auto" />
                                </div>
                            ) : (
                                'Select a host'
                            )}
                        </Button>

                        {/* Rule label */}
                        <div className="space-y-2 mt-6">
                            <Label className="text-xs">Label</Label>
                            <Input
                                placeholder={wizardType === 'dynamic' ? "e.g. SOCKS Proxy" : "e.g. MySQL Production"}
                                className="h-10"
                                value={draftRule.label || ''}
                                onChange={e => setDraftRule(prev => ({ ...prev, label: e.target.value }))}
                            />
                        </div>
                    </>
                );

            case 'label':
                return (
                    <>
                        <div className="text-sm font-medium mb-3">Select the label:</div>

                        <TrafficDiagram type={wizardType} isAnimating={true} />

                        <div className="space-y-2 mt-4">
                            <Label className="text-xs">Label</Label>
                            <Input
                                placeholder="e.g. Remote Rule"
                                className="h-10"
                                value={draftRule.label || ''}
                                onChange={e => setDraftRule(prev => ({ ...prev, label: e.target.value }))}
                            />
                        </div>
                    </>
                );

            default:
                return null;
        }
    };

    const hasRules = filteredRules.length > 0;

    return (
        <div className="flex h-full relative">
            {/* Main Content */}
            <div className={cn("flex-1 flex flex-col min-h-0", (showWizard || showEditPanel || showNewForm) ? "mr-[360px]" : "")}>
                {/* Toolbar */}
                <div className="h-14 px-4 flex items-center gap-3 bg-secondary/60 border-b border-border/60 relative z-20">
                    <Dropdown open={showNewMenu} onOpenChange={setShowNewMenu}>
                        <DropdownTrigger asChild>
                            <Button variant="secondary" className="h-9 px-3 gap-2">
                                <Zap size={14} />
                                NEW FORWARDING
                                <ChevronDown size={14} className={cn("transition-transform", showNewMenu ? "rotate-180" : "")} />
                            </Button>
                        </DropdownTrigger>
                        <DropdownContent className="w-52" align="start" sideOffset={8}>
                            <Button
                                variant="ghost"
                                className="w-full justify-start gap-3 h-10"
                                onClick={() => startNewRule('local')}
                            >
                                <Globe size={16} className="text-blue-500" />
                                Local Forwarding
                            </Button>
                            <Button
                                variant="ghost"
                                className="w-full justify-start gap-3 h-10"
                                onClick={() => startNewRule('remote')}
                            >
                                <Server size={16} className="text-orange-500" />
                                Remote Forwarding
                            </Button>
                            <Button
                                variant="ghost"
                                className="w-full justify-start gap-3 h-10"
                                onClick={() => startNewRule('dynamic')}
                            >
                                <Shuffle size={16} className="text-purple-500" />
                                Dynamic Forwarding
                            </Button>
                        </DropdownContent>
                    </Dropdown>

                    <div className="ml-auto flex items-center gap-2">
                        <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                placeholder="Search..."
                                className="h-9 pl-8 w-44"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                        </div>

                        {/* View mode toggle */}
                        <Dropdown>
                            <DropdownTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-9 w-9">
                                    {viewMode === 'grid' ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
                                    <ChevronDown size={10} className="ml-0.5" />
                                </Button>
                            </DropdownTrigger>
                            <DropdownContent className="w-32" align="end">
                                <Button
                                    variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                                    className="w-full justify-start gap-2 h-9"
                                    onClick={() => setViewMode('grid')}
                                >
                                    <LayoutGrid size={14} /> Grid
                                    {viewMode === 'grid' && <Check size={12} className="ml-auto" />}
                                </Button>
                                <Button
                                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                                    className="w-full justify-start gap-2 h-9"
                                    onClick={() => setViewMode('list')}
                                >
                                    <ListIcon size={14} /> List
                                    {viewMode === 'list' && <Check size={12} className="ml-auto" />}
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
                            <h3 className="text-lg font-semibold text-foreground mb-2">Set up port forwarding</h3>
                            <p className="text-sm text-center max-w-sm">
                                Save port forwarding to access databases, web apps, and other services.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-base font-semibold">Port Forwarding</h2>
                                <span className="text-xs text-muted-foreground">{filteredRules.length} rules</span>
                            </div>

                            <div className={cn(
                                viewMode === 'grid'
                                    ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                                    : "flex flex-col gap-2.5"
                            )}>
                                {filteredRules.map(rule => renderRuleCard(rule))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Edit Panel - shown when a rule is selected */}
            {showEditPanel && editingRule && (
                <AsidePanel
                    open={true}
                    onClose={closeEditPanel}
                    title="Edit Port Forwarding"
                    width="w-[360px]"
                    actions={
                        <AsideActionMenu>
                            <AsideActionMenuItem
                                icon={<Copy size={14} />}
                                onClick={() => {
                                    duplicateRule(editingRule.id);
                                    closeEditPanel();
                                }}
                            >
                                Duplicate
                            </AsideActionMenuItem>
                            <AsideActionMenuItem
                                icon={<Trash2 size={14} />}
                                variant="destructive"
                                onClick={() => {
                                    deleteRule(editingRule.id);
                                    closeEditPanel();
                                }}
                            >
                                Delete
                            </AsideActionMenuItem>
                        </AsideActionMenu>
                    }
                >
                    <AsidePanelContent>
                        {/* Traffic Diagram */}
                        <div className="-my-1">
                            <TrafficDiagram type={editDraft.type || editingRule.type} isAnimating={true} />
                        </div>

                        {/* Label */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Label</Label>
                            <Input
                                placeholder="Rule label"
                                className="h-10"
                                value={editDraft.label || ''}
                                onChange={e => setEditDraft(prev => ({ ...prev, label: e.target.value }))}
                            />
                        </div>

                        {/* Local Port */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Local port number *</Label>
                            <Input
                                type="number"
                                placeholder="e.g. 8080"
                                className="h-10"
                                value={editDraft.localPort || ''}
                                onChange={e => setEditDraft(prev => ({ ...prev, localPort: parseInt(e.target.value) || undefined }))}
                            />
                        </div>

                        {/* Bind Address */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Bind address</Label>
                            <Input
                                placeholder="127.0.0.1"
                                className="h-10"
                                value={editDraft.bindAddress || ''}
                                onChange={e => setEditDraft(prev => ({ ...prev, bindAddress: e.target.value }))}
                            />
                        </div>

                        {/* Intermediate Host - for all types */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Intermediate host *</Label>
                            <Button
                                variant="secondary"
                                className="w-full h-10 justify-between"
                                onClick={() => {
                                    setShowHostSelector(true);
                                }}
                            >
                                {hosts.find(h => h.id === editDraft.hostId) ? (
                                    <div className="flex items-center gap-2">
                                        <DistroAvatar
                                            host={hosts.find(h => h.id === editDraft.hostId)!}
                                            fallback={hosts.find(h => h.id === editDraft.hostId)!.os[0].toUpperCase()}
                                            className="h-6 w-6"
                                        />
                                        <span>{hosts.find(h => h.id === editDraft.hostId)?.label}</span>
                                    </div>
                                ) : (
                                    <span className="text-muted-foreground">Select a host</span>
                                )}
                                <ChevronDown size={14} />
                            </Button>
                        </div>

                        {/* Destination - for local/remote only */}
                        {(editDraft.type === 'local' || editDraft.type === 'remote') && (
                            <>
                                <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">Destination address *</Label>
                                    <Input
                                        placeholder="e.g. localhost or 192.168.1.100"
                                        className="h-10"
                                        value={editDraft.remoteHost || ''}
                                        onChange={e => setEditDraft(prev => ({ ...prev, remoteHost: e.target.value }))}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">Destination port number *</Label>
                                    <Input
                                        type="number"
                                        placeholder="e.g. 3306"
                                        className="h-10"
                                        value={editDraft.remotePort || ''}
                                        onChange={e => setEditDraft(prev => ({ ...prev, remotePort: parseInt(e.target.value) || undefined }))}
                                    />
                                </div>
                            </>
                        )}
                    </AsidePanelContent>
                    <AsidePanelFooter className="space-y-2">
                        <Button
                            className="w-full h-10"
                            onClick={saveEditedRule}
                        >
                            Save Changes
                        </Button>
                        <Button
                            variant="ghost"
                            className="w-full h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                            onClick={closeEditPanel}
                        >
                            Cancel
                        </Button>
                    </AsidePanelFooter>
                </AsidePanel>
            )}

            {/* Wizard Panel */}
            {showWizard && (
                <AsidePanel
                    open={true}
                    onClose={() => { setShowWizard(false); resetWizard(); }}
                    title={isEditing ? 'Edit Port Forwarding' : 'New Port Forwarding'}
                    width="w-[360px]"
                    showBackButton={!!getPrevStep()}
                    onBack={getPrevStep() ? () => {
                        const prev = getPrevStep();
                        if (prev) setWizardStep(prev);
                    } : undefined}
                >
                    <AsidePanelContent>
                        {renderWizardContent()}
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
                            {isLastStep() ? (isEditing ? 'Save Changes' : 'Done') : 'Continue'}
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
                            {isEditing ? 'Cancel' : 'Skip wizard'}
                        </Button>
                    </AsidePanelFooter>
                </AsidePanel>
            )}

            {/* Host Selector Overlay */}
            {showHostSelector && (
                <SelectHostPanel
                    hosts={hosts}
                    customGroups={customGroups}
                    selectedHostIds={
                        showEditPanel
                            ? (editDraft.hostId ? [editDraft.hostId] : [])
                            : showNewForm
                                ? (newFormDraft.hostId ? [newFormDraft.hostId] : [])
                                : (draftRule.hostId ? [draftRule.hostId] : [])
                    }
                    multiSelect={false}
                    onSelect={(host) => {
                        if (showEditPanel) {
                            setEditDraft(prev => ({ ...prev, hostId: host.id }));
                        } else if (showNewForm) {
                            setNewFormDraft(prev => ({ ...prev, hostId: host.id }));
                        } else {
                            setDraftRule(prev => ({ ...prev, hostId: host.id }));
                        }
                        setShowHostSelector(false);
                    }}
                    onBack={() => setShowHostSelector(false)}
                    onContinue={() => setShowHostSelector(false)}
                    availableKeys={keys}
                    onSaveHost={onSaveHost}
                    onCreateGroup={onCreateGroup}
                    title="Select Host"
                />
            )}

            {/* New Form Panel (skip wizard mode) */}
            {showNewForm && (
                <AsidePanel
                    open={true}
                    onClose={closeNewForm}
                    title="New Port Forwarding"
                    width="w-[360px]"
                >
                    <AsidePanelContent>
                        {/* Type Selector */}
                        <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
                            {(['local', 'remote', 'dynamic'] as PortForwardingType[]).map((type) => (
                                <Button
                                    key={type}
                                    variant={newFormDraft.type === type ? 'default' : 'ghost'}
                                    size="sm"
                                    className={cn(
                                        "flex-1 h-9",
                                        newFormDraft.type === type ? "bg-primary text-primary-foreground" : ""
                                    )}
                                    onClick={() => setNewFormDraft(prev => ({ ...prev, type }))}
                                >
                                    {type[0].toUpperCase() + type.slice(1)}
                                </Button>
                            ))}
                        </div>

                        {/* Traffic Diagram */}
                        <div className="-my-1">
                            <TrafficDiagram type={newFormDraft.type || 'local'} isAnimating={true} />
                        </div>

                        {/* Label */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Label</Label>
                            <Input
                                placeholder="Rule label"
                                className="h-10"
                                value={newFormDraft.label || ''}
                                onChange={e => setNewFormDraft(prev => ({ ...prev, label: e.target.value }))}
                            />
                        </div>

                        {/* Local Port */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Local port number *</Label>
                            <Input
                                type="number"
                                placeholder="e.g. 8080"
                                className="h-10"
                                value={newFormDraft.localPort || ''}
                                onChange={e => setNewFormDraft(prev => ({ ...prev, localPort: parseInt(e.target.value) || undefined }))}
                            />
                        </div>

                        {/* Bind Address */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Bind address</Label>
                            <Input
                                placeholder="127.0.0.1"
                                className="h-10"
                                value={newFormDraft.bindAddress || ''}
                                onChange={e => setNewFormDraft(prev => ({ ...prev, bindAddress: e.target.value }))}
                            />
                        </div>

                        {/* Intermediate Host */}
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">Intermediate host *</Label>
                            <Button
                                variant="secondary"
                                className="w-full h-10 justify-between"
                                onClick={() => setShowHostSelector(true)}
                            >
                                {hosts.find(h => h.id === newFormDraft.hostId) ? (
                                    <div className="flex items-center gap-2">
                                        <DistroAvatar
                                            host={hosts.find(h => h.id === newFormDraft.hostId)!}
                                            fallback={hosts.find(h => h.id === newFormDraft.hostId)!.os[0].toUpperCase()}
                                            className="h-6 w-6"
                                        />
                                        <span>{hosts.find(h => h.id === newFormDraft.hostId)?.label}</span>
                                    </div>
                                ) : (
                                    <span className="text-muted-foreground">Select a host</span>
                                )}
                                <ChevronDown size={14} />
                            </Button>
                        </div>

                        {/* Destination - for local/remote only */}
                        {(newFormDraft.type === 'local' || newFormDraft.type === 'remote') && (
                            <>
                                <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">Destination address *</Label>
                                    <Input
                                        placeholder="e.g. localhost or 192.168.1.100"
                                        className="h-10"
                                        value={newFormDraft.remoteHost || ''}
                                        onChange={e => setNewFormDraft(prev => ({ ...prev, remoteHost: e.target.value }))}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">Destination port number *</Label>
                                    <Input
                                        type="number"
                                        placeholder="e.g. 3306"
                                        className="h-10"
                                        value={newFormDraft.remotePort || ''}
                                        onChange={e => setNewFormDraft(prev => ({ ...prev, remotePort: parseInt(e.target.value) || undefined }))}
                                    />
                                </div>
                            </>
                        )}
                    </AsidePanelContent>
                    <AsidePanelFooter className="space-y-2">
                        <Button
                            className="w-full h-10"
                            disabled={!isNewFormValid()}
                            onClick={saveNewFormRule}
                        >
                            Create Rule
                        </Button>
                        <div className="flex items-center justify-between">
                            <Button
                                variant="ghost"
                                className="h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                                onClick={closeNewForm}
                            >
                                Cancel
                            </Button>
                            <button
                                className="text-xs text-muted-foreground hover:text-foreground/80 flex items-center gap-1 px-2 py-1 rounded hover:bg-foreground/5 transition-colors"
                                onClick={openWizardFromForm}
                                title="Open Port Forwarding Wizard"
                            >
                                <Zap size={12} />
                                Open Wizard
                            </button>
                        </div>
                    </AsidePanelFooter>
                </AsidePanel>
            )}
        </div>
    );
};

export default PortForwarding;
