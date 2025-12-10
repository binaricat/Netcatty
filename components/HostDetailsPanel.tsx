import React, { useEffect, useMemo, useState } from "react";
import { Host, SSHKey, ProxyConfig, ProxyType, HostChainConfig, EnvVar } from "../types";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { Network, KeyRound, Lock, Share2, Server, Shield, Zap, TerminalSquare, Tag, ChevronLeft, Navigation, PhoneCall, Plus, FolderPlus, ArrowLeft, Link2, Trash2, GripVertical, Globe, HelpCircle, X, ArrowDown, ArrowRight, Check, Variable } from "lucide-react";
import { ScrollArea } from "./ui/scroll-area";
import { DistroAvatar } from "./DistroAvatar";

type Protocol = "ssh" | "telnet";
type AuthMethod = "password" | "key" | "certificate" | "fido2";
type SubPanel = "none" | "create-group" | "proxy" | "chain" | "env-vars";

interface HostDetailsPanelProps {
  initialData?: Host | null;
  availableKeys: SSHKey[];
  groups: string[];
  allHosts?: Host[]; // All hosts for chain selection
  onSave: (host: Host) => void;
  onCancel: () => void;
  onCreateGroup?: (groupPath: string) => void; // Callback to create a new group
}

const HostDetailsPanel: React.FC<HostDetailsPanelProps> = ({
  initialData,
  availableKeys,
  groups,
  allHosts = [],
  onSave,
  onCancel,
  onCreateGroup
}) => {
  const [form, setForm] = useState<Host>(() => initialData || ({
    id: crypto.randomUUID(),
    label: "",
    hostname: "",
    port: 22,
    username: "root",
    protocol: "ssh",
    tags: [],
    os: "linux",
    agentForwarding: false,
    authMethod: "password",
    charset: "UTF-8",
    theme: "Flexoki Dark"
  } as Host));

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");
  
  // New group creation state
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupParent, setNewGroupParent] = useState("");
  
  // Group input state for inline creation suggestion
  const [groupInputValue, setGroupInputValue] = useState(form.group || "");
  const [showCreateGroupSuggestion, setShowCreateGroupSuggestion] = useState(false);

  const tagsInput = useMemo(() => form.tags?.join(", "), [form.tags]);
  
  // Check if the entered group is new (doesn't exist)
  const isNewGroup = useMemo(() => {
    const trimmed = groupInputValue.trim();
    return trimmed.length > 0 && !groups.includes(trimmed);
  }, [groupInputValue, groups]);

  useEffect(() => {
    if (initialData) {
      setForm(initialData);
      setGroupInputValue(initialData.group || "");
    }
  }, [initialData]);

  const update = <K extends keyof Host>(key: K, value: Host[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  
  const updateProxyConfig = (field: keyof ProxyConfig, value: string | number) => {
    setForm((prev) => ({
      ...prev,
      proxyConfig: {
        type: prev.proxyConfig?.type || 'http',
        host: prev.proxyConfig?.host || '',
        port: prev.proxyConfig?.port || 8080,
        ...prev.proxyConfig,
        [field]: value
      }
    }));
  };
  
  const clearProxyConfig = () => {
    setForm((prev) => {
      const { proxyConfig, ...rest } = prev;
      return rest as Host;
    });
  };
  
  const addHostToChain = (hostId: string) => {
    setForm((prev) => ({
      ...prev,
      hostChain: {
        hostIds: [...(prev.hostChain?.hostIds || []), hostId]
      }
    }));
  };
  
  const removeHostFromChain = (index: number) => {
    setForm((prev) => ({
      ...prev,
      hostChain: {
        hostIds: (prev.hostChain?.hostIds || []).filter((_, i) => i !== index)
      }
    }));
  };
  
  const clearHostChain = () => {
    setForm((prev) => {
      const { hostChain, ...rest } = prev;
      return rest as Host;
    });
  };
  
  // Environment variables state
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  
  const addEnvVar = () => {
    if (!newEnvName.trim()) return;
    const newVar: EnvVar = { name: newEnvName.trim(), value: newEnvValue };
    setForm((prev) => ({
      ...prev,
      environmentVariables: [...(prev.environmentVariables || []), newVar]
    }));
    setNewEnvName("");
    setNewEnvValue("");
  };
  
  const removeEnvVar = (index: number) => {
    setForm((prev) => ({
      ...prev,
      environmentVariables: (prev.environmentVariables || []).filter((_, i) => i !== index)
    }));
  };

  const handleSubmit = () => {
    if (!form.hostname || !form.label) return;
    const cleaned: Host = {
      ...form,
      group: groupInputValue.trim() || form.group,
      tags: form.tags || [],
      port: form.port || 22,
    };
    onSave(cleaned);
  };
  
  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    const fullPath = newGroupParent ? `${newGroupParent}/${newGroupName.trim()}` : newGroupName.trim();
    onCreateGroup?.(fullPath);
    setGroupInputValue(fullPath);
    update("group", fullPath);
    setNewGroupName("");
    setNewGroupParent("");
    setActiveSubPanel("none");
  };
  
  const handleGroupInputChange = (value: string) => {
    setGroupInputValue(value);
    update("group", value);
    setShowCreateGroupSuggestion(true);
  };
  
  const handleCreateGroupFromInput = () => {
    if (!isNewGroup) return;
    // Open the create group sub-panel with the current input pre-filled
    setNewGroupName(groupInputValue.trim());
    setActiveSubPanel("create-group");
    setShowCreateGroupSuggestion(false);
  };

  const setTelnetDefaults = () => {
    setForm((prev) => ({
      ...prev,
      protocol: "telnet",
      port: prev.port || 23,
      authMethod: "password",
      identityFileId: "",
    }));
  };
  
  // Get available hosts for chain (exclude current host)
  const availableHostsForChain = useMemo(() => {
    const chainedIds = new Set(form.hostChain?.hostIds || []);
    return allHosts.filter(h => h.id !== form.id && !chainedIds.has(h.id));
  }, [allHosts, form.id, form.hostChain?.hostIds]);
  
  // Get hosts in chain
  const chainedHosts = useMemo(() => {
    const ids = form.hostChain?.hostIds || [];
    return ids.map(id => allHosts.find(h => h.id === id)).filter(Boolean) as Host[];
  }, [allHosts, form.hostChain?.hostIds]);

  // Render sub-panels
  if (activeSubPanel === "create-group") {
    return (
      <div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-secondary/90 backdrop-blur z-50 flex flex-col">
        {/* Header - Fixed */}
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setActiveSubPanel("none")}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <p className="text-sm font-semibold">New Group</p>
              <p className="text-xs text-muted-foreground">Personal vault</p>
            </div>
          </div>
          <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
            Save
          </Button>
        </div>
        
        {/* Content - Scrollable */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <p className="text-xs font-semibold">General</p>
            <div className="flex items-center gap-2">
              <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center">
                <FolderPlus size={18} className="text-primary" />
              </div>
              <Input
                placeholder="Group name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="h-10 flex-1"
                autoFocus
              />
            </div>
            <div className="relative">
              <Input
                placeholder="Parent Group"
                value={newGroupParent}
                onChange={(e) => setNewGroupParent(e.target.value)}
                list="parent-group-options"
                className="h-10"
              />
              <datalist id="parent-group-options">
                {groups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
          </Card>
          
          <Card className="p-3 space-y-2 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold">Cloud Sync</p>
              <HelpCircle size={14} className="text-muted-foreground" />
            </div>
            <ToggleRow label="Cloud Sync" enabled={false} onToggle={() => {}} />
          </Card>
          
          <Button variant="ghost" className="w-full h-10 gap-2">
            <Plus size={16} /> Add protocol
          </Button>
          </div>
        </ScrollArea>
      </div>
    );
  }
  
  if (activeSubPanel === "proxy") {
    return (
      <div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-secondary/90 backdrop-blur z-50 flex flex-col">
        {/* Header - Fixed */}
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setActiveSubPanel("none")}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <p className="text-sm font-semibold">New Proxy</p>
              <p className="text-xs text-muted-foreground">Personal vault</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setActiveSubPanel("none")} disabled={!form.proxyConfig?.host}>
            Save
          </Button>
        </div>
        
        {/* Content - Scrollable */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold">Type</p>
              <div className="flex gap-2">
                <Button
                  variant={form.proxyConfig?.type === 'http' ? "secondary" : "ghost"}
                  size="sm"
                  className={cn("h-8", form.proxyConfig?.type === 'http' && "bg-primary/15")}
                  onClick={() => updateProxyConfig('type', 'http')}
                >
                  <Check size={14} className={cn("mr-1", form.proxyConfig?.type !== 'http' && "opacity-0")} />
                  HTTP
                </Button>
                <Button
                  variant={form.proxyConfig?.type === 'socks5' ? "secondary" : "ghost"}
                  size="sm"
                  className={cn("h-8", form.proxyConfig?.type === 'socks5' && "bg-primary/15")}
                  onClick={() => updateProxyConfig('type', 'socks5')}
                >
                  <Check size={14} className={cn("mr-1", form.proxyConfig?.type !== 'socks5' && "opacity-0")} />
                  SOCKS5
                </Button>
              </div>
            </div>
            
            <div className="flex gap-2">
              <Input
                placeholder="Proxy Host"
                value={form.proxyConfig?.host || ""}
                onChange={(e) => updateProxyConfig('host', e.target.value)}
                className="h-10 flex-1"
              />
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">Port</span>
                <Input
                  type="number"
                  placeholder="3128"
                  value={form.proxyConfig?.port || ""}
                  onChange={(e) => updateProxyConfig('port', parseInt(e.target.value) || 0)}
                  className="h-10 w-20 text-center"
                />
              </div>
            </div>
          </Card>
          
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold">Credentials</p>
              <Badge variant="secondary" className="text-xs">Optional</Badge>
            </div>
            <Input
              placeholder="Proxy Username"
              value={form.proxyConfig?.username || ""}
              onChange={(e) => updateProxyConfig('username', e.target.value)}
              className="h-10"
            />
            <Input
              placeholder="Proxy Password"
              type="password"
              value={form.proxyConfig?.password || ""}
              onChange={(e) => updateProxyConfig('password', e.target.value)}
              className="h-10"
            />
            <Button variant="ghost" size="sm" className="text-primary" onClick={() => {}}>
              Identities
            </Button>
          </Card>
          
          {form.proxyConfig?.host && (
            <Button variant="ghost" className="w-full h-10 text-destructive" onClick={clearProxyConfig}>
              <Trash2 size={14} className="mr-2" /> Remove Proxy
            </Button>
          )}
          </div>
        </ScrollArea>
      </div>
    );
  }
  
  if (activeSubPanel === "chain") {
    return (
      <div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-secondary/90 backdrop-blur z-50 flex flex-col">
        {/* Header - Fixed */}
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setActiveSubPanel("none")}>
              <ArrowLeft size={16} />
            </Button>
            <div className="flex items-center gap-1">
              <p className="text-sm font-semibold">Edit Chain</p>
              <HelpCircle size={14} className="text-muted-foreground" />
            </div>
          </div>
          <Button size="sm" onClick={() => setActiveSubPanel("none")}>
            Save
          </Button>
        </div>
        
        {/* Content - Scrollable */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <p className="text-xs text-muted-foreground">
                Adding another host will create a connection to <span className="font-semibold text-foreground">{form.label || form.hostname}</span>
              </p>
            <Button className="w-full h-10" onClick={() => {}}>
              <Plus size={14} className="mr-2" /> Add a Host
            </Button>
          </Card>
          
          {/* Chain visualization */}
          <div className="space-y-2">
            {chainedHosts.map((host, index) => (
              <React.Fragment key={host.id}>
                {index > 0 && (
                  <div className="flex justify-center py-1">
                    <ArrowDown size={16} className="text-muted-foreground" />
                  </div>
                )}
                <div className="flex items-center gap-2 p-2 rounded-lg border border-border/60 bg-card">
                  <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-8 w-8" />
                  <span className="text-sm font-medium flex-1">{host.label || host.hostname}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => removeHostFromChain(index)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </React.Fragment>
            ))}
            
            {chainedHosts.length > 0 && (
              <div className="flex justify-center py-1">
                <ArrowDown size={16} className="text-muted-foreground" />
              </div>
            )}
            
            {/* Target host (current) */}
            <div className="flex items-center gap-2 p-2 rounded-lg border-2 border-primary/30 bg-primary/5">
              <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center">
                <Server size={14} className="text-primary" />
              </div>
              <span className="text-sm font-medium text-primary">{form.label || form.hostname || "Target"}</span>
            </div>
          </div>
          
          {/* Available hosts to add */}
          {availableHostsForChain.length > 0 && (
            <Card className="p-3 space-y-2 bg-card border-border/80">
              <p className="text-xs font-semibold text-muted-foreground">Available Hosts</p>
              <ScrollArea className="max-h-48">
                <div className="space-y-1">
                  {availableHostsForChain.map((host) => (
                    <button
                      key={host.id}
                      className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-secondary transition-colors text-left"
                      onClick={() => addHostToChain(host.id)}
                    >
                      <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-8 w-8" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{host.label}</div>
                        <div className="text-xs text-muted-foreground truncate">{host.hostname}</div>
                      </div>
                      <Plus size={14} className="text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </Card>
          )}
          
          {chainedHosts.length > 0 && (
            <Button variant="ghost" className="w-full h-10 text-destructive" onClick={clearHostChain}>
              Clear
            </Button>
          )}
          </div>
        </ScrollArea>
      </div>
    );
  }
  
  // Environment Variables sub-panel
  if (activeSubPanel === "env-vars") {
    return (
      <div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-secondary/90 backdrop-blur z-50 flex flex-col">
        {/* Header - Fixed */}
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setActiveSubPanel("none")}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <p className="text-sm font-semibold">Environment Variables</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setActiveSubPanel("none")}>
            Save
          </Button>
        </div>
        
        {/* Content - Scrollable */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            <div className="text-sm text-muted-foreground">
              Set an environment variable for <span className="font-semibold text-foreground">{form.label || form.hostname}</span>.
              <p className="text-xs mt-1">Some SSH servers by default only allow variables with prefix LC_ and LANG_.</p>
          </div>
          
          <Button className="w-full h-10" onClick={addEnvVar} disabled={!newEnvName.trim()}>
            <Plus size={14} className="mr-2" /> Add a variable
          </Button>
          
          {/* Existing variables */}
          {(form.environmentVariables || []).map((envVar, index) => (
            <Card key={index} className="p-3 space-y-2 bg-card border-border/80">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Variable</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => removeEnvVar(index)}
                >
                  <X size={14} />
                </Button>
              </div>
              <Input
                placeholder="Variable"
                value={envVar.name}
                onChange={(e) => {
                  const newVars = [...(form.environmentVariables || [])];
                  newVars[index] = { ...newVars[index], name: e.target.value };
                  setForm(prev => ({ ...prev, environmentVariables: newVars }));
                }}
                className="h-10"
              />
              <Input
                placeholder="Value"
                value={envVar.value}
                onChange={(e) => {
                  const newVars = [...(form.environmentVariables || [])];
                  newVars[index] = { ...newVars[index], value: e.target.value };
                  setForm(prev => ({ ...prev, environmentVariables: newVars }));
                }}
                className="h-10"
              />
            </Card>
          ))}
          
          {/* New variable input */}
          <Card className="p-3 space-y-2 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">Variable</span>
              <X size={14} className="text-muted-foreground opacity-0" />
            </div>
            <Input
              placeholder="Variable"
              value={newEnvName}
              onChange={(e) => setNewEnvName(e.target.value)}
              className="h-10"
            />
            <Input
              placeholder="Value"
              value={newEnvValue}
              onChange={(e) => setNewEnvValue(e.target.value)}
              className="h-10"
            />
          </Card>
          </div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[380px] border-l border-border/60 bg-secondary/90 backdrop-blur z-50 flex flex-col">
      {/* Header - Fixed */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag">
        <div>
          <p className="text-sm font-semibold">{initialData ? "Host Details" : "New Host"}</p>
          <p className="text-xs text-muted-foreground">Personal vault</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSubmit} disabled={!form.hostname || !form.label} aria-label="Save">
            <Check size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More options">
            <Navigation size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onCancel} aria-label="Close">
            <ArrowLeft size={16} />
          </Button>
        </div>
      </div>

      {/* Content - Scrollable */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <Card className="p-3 space-y-2 bg-card border-border/80">
            <p className="text-xs font-semibold">Address</p>
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center">
              <Server size={18} className="text-primary" />
            </div>
            <Input
              placeholder="IP or Hostname"
              value={form.hostname}
              onChange={(e) => update("hostname", e.target.value)}
              className="h-10 flex-1"
            />
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <p className="text-xs font-semibold">General</p>
          <Input 
            placeholder="Label (e.g., Production Server)" 
            value={form.label} 
            onChange={(e) => update("label", e.target.value)} 
            className="h-10" 
          />
          
          {/* Group input with inline create suggestion */}
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="h-10 w-10 rounded-lg bg-secondary/80 flex items-center justify-center">
                <FolderPlus size={16} className="text-muted-foreground" />
              </div>
              <Input
                placeholder="Group"
                value={groupInputValue}
                onChange={(e) => handleGroupInputChange(e.target.value)}
                onFocus={() => setShowCreateGroupSuggestion(true)}
                onBlur={() => setTimeout(() => setShowCreateGroupSuggestion(false), 150)}
                list="group-options"
                className="h-10 flex-1"
              />
            </div>
            {showCreateGroupSuggestion && isNewGroup && (
              <button
                className="absolute left-12 right-0 top-full mt-1 z-10 flex items-center gap-2 px-3 py-2 rounded-md bg-card border border-border/80 shadow-lg hover:bg-secondary transition-colors text-left"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCreateGroupFromInput}
              >
                <Plus size={14} className="text-primary" />
                <span className="text-sm">Create Group</span>
                <span className="text-sm font-medium text-primary">{groupInputValue}</span>
              </button>
            )}
            <datalist id="group-options">
              {groups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-secondary/80 flex items-center justify-center">
              <Tag size={16} className="text-muted-foreground" />
            </div>
            <div className="flex-1 flex items-center gap-1 bg-secondary/50 rounded-md border border-border/60 px-2 h-10">
              <span className="text-xs text-muted-foreground">Namespace</span>
              <span className="text-sm font-medium">Default</span>
            </div>
          </div>
        </Card>

        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-2 py-1">
            <span className="text-xs text-muted-foreground">SSH on</span>
            <Input
              type="number"
              value={form.port}
              onChange={(e) => update("port", Number(e.target.value))}
              className="h-8 w-16 text-center"
            />
            <span className="text-xs text-muted-foreground">port</span>
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <p className="text-xs font-semibold">Credentials</p>
          <div className="grid gap-2">
            <Input placeholder="Username" value={form.username} onChange={(e) => update("username", e.target.value)} className="h-10" />
            {form.authMethod !== "key" && (
              <Input placeholder="Password" type="password" value={form.password || ""} onChange={(e) => update("password", e.target.value)} className="h-10" />
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Plus size={12} />
              <span>SSH.id, Key, Certificate, FIDO2</span>
            </div>
          </div>
        </Card>

        <Card className="p-3 space-y-2 bg-card border-border/80">
          <ToggleRow
            label="Agent Forwarding"
            enabled={!!form.agentForwarding}
            onToggle={() => update("agentForwarding", !form.agentForwarding)}
          />
        </Card>
        
        {/* Host Chain Configuration - Only show when Agent Forwarding is enabled */}
        {form.agentForwarding && (
          <Card className="p-3 space-y-2 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Link2 size={14} className="text-muted-foreground" />
                <p className="text-xs font-semibold">Jump Hosts</p>
              </div>
              {chainedHosts.length > 0 ? (
                <Badge variant="secondary" className="text-xs">
                  {chainedHosts.length} hop{chainedHosts.length > 1 ? 's' : ''}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-muted-foreground">Direct</Badge>
              )}
            </div>
            {chainedHosts.length > 0 && (
              <button
                className="w-full flex items-center gap-1 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
                onClick={() => setActiveSubPanel("chain")}
              >
                <Link2 size={14} className="text-muted-foreground flex-shrink-0" />
                <span className="text-sm truncate">
                  {chainedHosts.slice(0, 3).map(h => h.hostname || h.label).join(' -> ')}
                  {chainedHosts.length > 3 && '...'}
                </span>
                <X
                  size={14}
                  className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-auto"
                  onClick={(e) => { e.stopPropagation(); clearHostChain(); }}
                />
              </button>
            )}
            {chainedHosts.length === 0 && (
              <Button
                variant="ghost"
                className="w-full h-9 justify-start gap-2 text-sm"
                onClick={() => setActiveSubPanel("chain")}
              >
                <Plus size={14} />
                Configure Jump Hosts
              </Button>
            )}
          </Card>
        )}
        
        {/* Proxy Configuration */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">Proxy</p>
            </div>
            {form.proxyConfig?.host ? (
              <Badge variant="secondary" className="text-xs">
                {form.proxyConfig.type?.toUpperCase()} {form.proxyConfig.host}:{form.proxyConfig.port}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">None</Badge>
            )}
          </div>
          <Button
            variant="ghost"
            className="w-full h-9 justify-start gap-2 text-sm"
            onClick={() => setActiveSubPanel("proxy")}
          >
            <Plus size={14} />
            {form.proxyConfig?.host ? "Edit Proxy" : "Configure Proxy"}
          </Button>
        </Card>
        
        {/* Environment Variables */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Variable size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">Environment Variable</p>
            </div>
          </div>
          {(form.environmentVariables?.length || 0) > 0 ? (
            <button
              className="w-full flex items-center gap-1 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
              onClick={() => setActiveSubPanel("env-vars")}
            >
              <span className="text-sm truncate">
                {form.environmentVariables?.slice(0, 2).map(v => `${v.name}=${v.value}`).join(', ')}
                {(form.environmentVariables?.length || 0) > 2 && '...'}
              </span>
              <X
                size={14}
                className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-auto"
                onClick={(e) => { e.stopPropagation(); setForm(prev => ({ ...prev, environmentVariables: [] })); }}
              />
            </button>
          ) : (
          <Button
            variant="ghost"
            className="w-full h-9 justify-start gap-2 text-sm"
            onClick={() => setActiveSubPanel("env-vars")}
          >
            <Plus size={14} />
            Add Environment Variable
          </Button>
          )}
        </Card>

        {/* Startup Command */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <TerminalSquare size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">Startup Command</p>
          </div>
          <Input
            placeholder="Command to run on connect (e.g., cd /app && ls)"
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value)}
            className="h-9"
          />
          <p className="text-xs text-muted-foreground">This command will be executed automatically after SSH connection is established.</p>
        </Card>

        <Button className="w-full h-12" onClick={handleSubmit} disabled={!form.hostname || !form.label}>
          Connect
        </Button>
        </div>
      </ScrollArea>
    </div>
  );
};

interface ToggleRowProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, enabled, onToggle }) => (
  <div className="flex items-center justify-between h-10 px-3 rounded-md border border-border/70 bg-secondary/70">
    <span className="text-sm">{label}</span>
    <Button variant={enabled ? "secondary" : "ghost"} size="sm" className={cn("h-8 min-w-[72px]", enabled && "bg-primary/20")} onClick={onToggle}>
      {enabled ? "Enabled" : "Disabled"}
    </Button>
  </div>
);

export default HostDetailsPanel;
