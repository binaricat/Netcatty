import React, { useMemo, useState } from 'react';
import { Host, Snippet } from '../types';
import { FileCode, Plus, Trash2, Edit2, Copy, Clock, List as ListIcon, FolderPlus, Grid, Server, Play } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Card } from './ui/card';
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent, DialogDescription } from './ui/dialog';
import { Label } from './ui/label';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { cn } from '../lib/utils';

interface SnippetsManagerProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  onSave: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
  onPackagesChange: (packages: string[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
}

const SnippetsManager: React.FC<SnippetsManagerProps> = ({ snippets, packages, hosts, onSave, onDelete, onPackagesChange, onRunSnippet }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>({
    label: '',
    command: '',
    package: '',
    targets: [],
  });
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false);
  const [targetSelection, setTargetSelection] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(true);
  const [newPackageName, setNewPackageName] = useState('');
  const [isPackageDialogOpen, setIsPackageDialogOpen] = useState(false);
  const [historyLabelDraft, setHistoryLabelDraft] = useState<Record<string, string>>({});
  const [tempTargets, setTempTargets] = useState<string[]>([]);

  const handleEdit = (snippet?: Snippet) => {
    if (snippet) setEditingSnippet(snippet);
    else setEditingSnippet({ label: '', command: '', package: selectedPackage || '', targets: [] });
    setIsDialogOpen(true);
    setTargetSelection(snippet?.targets || []);
  };

  const handleSubmit = () => {
    if (editingSnippet.label && editingSnippet.command) {
      onSave({
        id: editingSnippet.id || crypto.randomUUID(),
        label: editingSnippet.label,
        command: editingSnippet.command,
        tags: editingSnippet.tags || [],
        package: editingSnippet.package || '',
        targets: targetSelection,
      });
      setIsDialogOpen(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const targetHosts = useMemo(() => {
    return targetSelection
      .map((id) => hosts.find((h) => h.id === id))
      .filter((h): h is Host => Boolean(h));
  }, [targetSelection, hosts]);

  const historyItems = useMemo(() => {
    return [
      'ls',
      'cd /var/log',
      'tail -f syslog',
      'docker ps -a',
      'htop',
      'docker images',
      'journalctl -xe',
    ];
  }, []);

  const openTargetPicker = () => {
    setTempTargets(targetSelection);
    setIsTargetPickerOpen(true);
  };

  const displayedPackages = useMemo(() => {
    if (!selectedPackage) {
      const roots = packages
        .map((p) => p.split('/')[0])
        .filter(Boolean);
      return Array.from(new Set(roots)).map((name) => {
        const path = name;
        const count = snippets.filter((s) => (s.package || '') === path).length;
        return { name, path, count };
      });
    }
    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter(Boolean);
    return Array.from(new Set(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      const count = snippets.filter((s) => (s.package || '') === path).length;
      return { name, path, count };
    });
  }, [packages, selectedPackage, snippets]);

  const displayedSnippets = useMemo(() => {
    return snippets.filter((s) => (s.package || '') === (selectedPackage || ''));
  }, [snippets, selectedPackage]);

  const breadcrumb = useMemo(() => {
    if (!selectedPackage) return [];
    const parts = selectedPackage.split('/').filter(Boolean);
    return parts.map((name, idx) => ({ name, path: parts.slice(0, idx + 1).join('/') }));
  }, [selectedPackage]);

  const createPackage = () => {
    const name = newPackageName.trim();
    if (!name) return;
    const full = selectedPackage ? `${selectedPackage}/${name}` : name;
    if (!packages.includes(full)) onPackagesChange([...packages, full]);
    setNewPackageName('');
    setIsPackageDialogOpen(false);
  };

  const deletePackage = (path: string) => {
    const keep = packages.filter((p) => !(p === path || p.startsWith(path + '/')));
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === path || s.package.startsWith(path + '/')) return { ...s, package: '' };
      return s;
    });
    onPackagesChange(keep);
    updatedSnippets.forEach(onSave);
    if (selectedPackage && (selectedPackage === path || selectedPackage.startsWith(path + '/'))) {
      setSelectedPackage(null);
    }
  };

  const movePackage = (source: string, target: string | null) => {
    const name = source.split('/').pop() || '';
    const newPath = target ? `${target}/${name}` : name;
    if (newPath === source || newPath.startsWith(source + '/')) return;
    const updatedPackages = packages.map((p) => {
      if (p === source) return newPath;
      if (p.startsWith(source + '/')) return p.replace(source, newPath);
      return p;
    });
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === source) return { ...s, package: newPath };
      if (s.package.startsWith(source + '/')) return { ...s, package: s.package.replace(source, newPath) };
      return s;
    });
    onPackagesChange(Array.from(new Set(updatedPackages)));
    updatedSnippets.forEach(onSave);
    if (selectedPackage === source) setSelectedPackage(newPath);
  };

  const moveSnippet = (id: string, pkg: string | null) => {
    const sn = snippets.find((s) => s.id === id);
    if (!sn) return;
    onSave({ ...sn, package: pkg || '' });
  };

  const toggleTarget = (snippet: Snippet, hostId: string) => {
    const current = snippet.targets || [];
    const exists = current.includes(hostId);
    const next = exists ? current.filter((id) => id !== hostId) : [...current, hostId];
    onSave({ ...snippet, targets: next });
  };

  return (
    <div className="px-2.5 py-2.5 lg:px-3 lg:py-3 h-full overflow-hidden flex gap-3">
      <div className="flex-1 flex flex-col min-h-0 space-y-3">
        <div className="flex items-center gap-2">
          <Button onClick={() => handleEdit()} size="sm" className="h-9">
            <Plus size={14} className="mr-2" /> New Snippet
          </Button>
          <Button
            onClick={() => {
              setNewPackageName('');
              setIsPackageDialogOpen(true);
            }}
            size="sm"
            variant="secondary"
            className="h-9 gap-2"
          >
            <FolderPlus size={14} className="mr-1" /> New Package
          </Button>
          <Button variant="ghost" size="sm" className="h-9 gap-2" onClick={() => setIsHistoryOpen((v) => !v)}>
            <Clock size={14} /> Shell History
          </Button>
          <div className="flex items-center gap-2 ml-auto text-sm text-muted-foreground">
            <button className="text-primary hover:underline" onClick={() => setSelectedPackage(null)}>All packages</button>
            {breadcrumb.map((b) => (
              <span key={b.path} className="flex items-center gap-1">
                <span className="text-muted-foreground">›</span>
                <button className="text-primary hover:underline" onClick={() => setSelectedPackage(b.path)}>{b.name}</button>
              </span>
            ))}
          </div>
        </div>

        {!snippets.length && displayedPackages.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-md w-full text-center space-y-3 py-12 rounded-2xl bg-secondary/60 border border-border/60 shadow-lg">
              <div className="mx-auto h-12 w-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center">
                <FileCode size={22} />
              </div>
              <div className="text-sm font-semibold text-foreground">Create snippet</div>
              <div className="text-xs text-muted-foreground px-8">Save your most used commands as snippets to reuse them in one click.</div>
            </div>
          </div>
        )}

        <div className="space-y-3 overflow-y-auto pr-1">
          {displayedPackages.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Packages</h3>
              </div>
              <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                {displayedPackages.map((pkg) => (
                  <ContextMenu key={pkg.path}>
                    <ContextMenuTrigger>
                      <Card
                        className="group bg-secondary/70 border border-border/70 hover:border-primary/60 transition-colors h-[72px] px-3 py-2 cursor-pointer"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('pkg-path', pkg.path);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const sId = e.dataTransfer.getData('snippet-id');
                          const pPath = e.dataTransfer.getData('pkg-path');
                          if (sId) moveSnippet(sId, pkg.path);
                          if (pPath) movePackage(pPath, pkg.path);
                        }}
                        onClick={() => setSelectedPackage(pkg.path)}
                      >
                        <div className="flex items-center gap-3 h-full">
                          <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
                            <Grid size={16} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{pkg.name}</div>
                            <div className="text-[11px] text-muted-foreground">{pkg.count} snippet{pkg.count === 1 ? '' : 's'}</div>
                          </div>
                        </div>
                      </Card>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setSelectedPackage(pkg.path)}>Open</ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => deletePackage(pkg.path)}>Delete</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </>
          )}

          {displayedSnippets.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground">Snippets</h3>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                {displayedSnippets.map((snippet) => (
                  <ContextMenu key={snippet.id}>
                    <ContextMenuTrigger>
                      <Card
                        className="group relative bg-secondary/70 border border-border/70 hover:border-primary/60 transition-colors h-[72px] px-3 py-2 cursor-pointer"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('snippet-id', snippet.id);
                        }}
                      >
                        <div className="flex items-center gap-3 h-full">
                          <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
                            <FileCode size={16} />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="text-sm font-semibold truncate">{snippet.label}</div>
                            <div className="text-[11px] text-muted-foreground font-mono leading-4 truncate">
                              {snippet.command.replace(/\s+/g, ' ') || 'Command'}
                            </div>
                          </div>
                        </div>
                      </Card>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem 
                        onClick={() => {
                          const targetHostsList = (snippet.targets || [])
                            .map(id => hosts.find(h => h.id === id))
                            .filter((h): h is Host => Boolean(h));
                          if (targetHostsList.length > 0) {
                            onRunSnippet?.(snippet, targetHostsList);
                          }
                        }}
                        disabled={!snippet.targets?.length}
                      >
                        <Play className="mr-2 h-4 w-4" /> Run
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => handleEdit(snippet)}>
                        <Edit2 className="mr-2 h-4 w-4" /> Edit
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopy(snippet.id, snippet.command)}>
                        <Copy className="mr-2 h-4 w-4" /> Copy
                      </ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => onDelete(snippet.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {isHistoryOpen && (
        <div className="w-72 bg-secondary/70 border border-border/60 rounded-xl p-3 flex-shrink-0 hidden lg:flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm font-semibold text-muted-foreground">
            <span>Shell History</span>
            <ListIcon size={14} className="text-muted-foreground" />
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 text-[12px] text-foreground">
            {historyItems.map((item, idx) => {
              const labelDraft = historyLabelDraft[item];
              return (
                <div key={`${item}-${idx}`} className="group rounded-md bg-background/60 border border-border/50 px-2 py-2 font-mono">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 text-[13px] leading-5">
                      {labelDraft !== undefined ? (
                        <>
                          <Input
                            placeholder="Set a label"
                            value={labelDraft}
                            onChange={(e) => setHistoryLabelDraft({ ...historyLabelDraft, [item]: e.target.value })}
                            className="h-8 mb-1"
                          />
                          <div className="text-[11px] text-muted-foreground truncate">{item}</div>
                        </>
                      ) : (
                        <div className="truncate">{item}</div>
                      )}
                    </div>
                    {labelDraft === undefined && (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-6 px-3 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setHistoryLabelDraft({ ...historyLabelDraft, [item]: '' })}
                      >
                        Save
                      </Button>
                    )}
                  </div>
                  {labelDraft !== undefined && (
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() => {
                          const next = { ...historyLabelDraft };
                          delete next[item];
                          setHistoryLabelDraft(next);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2.5"
                        onClick={() => {
                          if (!labelDraft.trim()) return;
                          onSave({
                            id: crypto.randomUUID(),
                            label: labelDraft.trim(),
                            command: item,
                            package: selectedPackage || '',
                            targets: [],
                          });
                          const next = { ...historyLabelDraft };
                          delete next[item];
                          setHistoryLabelDraft(next);
                        }}
                      >
                        Done
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Dialog
        open={isPackageDialogOpen}
        onOpenChange={(open) => {
          setIsPackageDialogOpen(open);
          if (!open) setNewPackageName('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Package</DialogTitle>
            <DialogDescription className="sr-only">Create a package to group your snippets.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="text-xs text-muted-foreground">
              Parent: {selectedPackage ? selectedPackage : 'Root'}
            </div>
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                autoFocus
                placeholder="e.g. ops/maintenance"
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPackage()}
              />
              <p className="text-[11px] text-muted-foreground">Use “/” to create nested packages.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsPackageDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createPackage}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSnippet.id ? 'Edit Snippet' : 'New Snippet'}</DialogTitle>
            <DialogDescription className="sr-only">Create or edit a reusable command snippet.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>Label</Label>
              <Input
                placeholder="e.g. Update System, Check Disk Usage"
                value={editingSnippet.label}
                onChange={e => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label>Command / Script</Label>
              <Textarea
                placeholder="#!/bin/bash..."
                className="h-48 font-mono text-xs"
                value={editingSnippet.command}
                onChange={e => setEditingSnippet({ ...editingSnippet, command: e.target.value })}
              />
              <p className="text-[10px] text-muted-foreground">Multi-line commands are supported.</p>
            </div>

            <div className="grid gap-2">
              <Label>Package</Label>
              <Input
                placeholder="e.g. infra/ops"
                value={editingSnippet.package || selectedPackage || ''}
                onChange={(e) => setEditingSnippet({ ...editingSnippet, package: e.target.value })}
              />
              <p className="text-[10px] text-muted-foreground">Use “/” to create sub-packages.</p>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Targets</Label>
                {targetHosts.length > 0 && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={openTargetPicker}>
                    Edit
                  </Button>
                )}
              </div>
              {targetHosts.length === 0 ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {[1, 2].map((idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-2 text-muted-foreground"
                      >
                        <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
                          <Server size={16} />
                        </div>
                        <div className="text-xs leading-4">
                          <div className="font-semibold">IP or Hostname</div>
                          <div className="text-[11px] text-muted-foreground">SSH</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Button size="sm" className="w-full h-9" variant="secondary" onClick={openTargetPicker}>
                    Add targets
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                    {targetHosts.map((h) => (
                      <Card key={h.id} className="flex items-center gap-3 px-3 py-2 bg-background/60 border border-border/70">
                        <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
                          <Server size={16} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">{h.label}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {h.username || 'ssh'}@{h.hostname}:{h.port || 22}
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit}>Save Snippet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isTargetPickerOpen} onOpenChange={setIsTargetPickerOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add targets</DialogTitle>
            <DialogDescription className="text-sm">
              Select hosts to run this snippet against. You can add multiple targets.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[360px] overflow-y-auto space-y-2">
            {hosts.map((h) => {
              const active = tempTargets.includes(h.id);
              return (
                <Card
                  key={h.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 cursor-pointer border",
                    active ? "border-primary bg-primary/10" : "border-border/70 bg-background/70"
                  )}
                  onClick={() => {
                    setTempTargets((prev) =>
                      prev.includes(h.id) ? prev.filter((id) => id !== h.id) : [...prev, h.id]
                    );
                  }}
                >
                  <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
                    <Server size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{h.label}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {h.username || 'ssh'}@{h.hostname}:{h.port || 22}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "h-4 w-4 rounded-full border",
                      active ? "bg-primary border-primary" : "border-border"
                    )}
                  />
                </Card>
              );
            })}
          </div>
          <DialogFooter className="flex justify-between sm:justify-between">
            <Button
              variant="ghost"
              onClick={() => {
                setTempTargets(targetSelection);
                setIsTargetPickerOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setTargetSelection(tempTargets);
                setIsTargetPickerOpen(false);
              }}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SnippetsManager;
