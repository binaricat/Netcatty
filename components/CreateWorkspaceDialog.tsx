import { Search } from 'lucide-react';
import React, { useMemo, useState, useEffect } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { Host } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';

interface CreateWorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  hosts: Host[];
  onCreate: (name: string, selectedHosts: Host[]) => void;
}

export const CreateWorkspaceDialog: React.FC<CreateWorkspaceDialogProps> = ({
  isOpen,
  onClose,
  hosts,
  onCreate,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());

  const filteredHosts = useMemo(() => {
    if (!search.trim()) return hosts;
    const term = search.toLowerCase();
    return hosts.filter(h =>
      h.label.toLowerCase().includes(term) ||
      h.hostname.toLowerCase().includes(term) ||
      (h.group || '').toLowerCase().includes(term)
    );
  }, [hosts, search]);

  const toggleHost = (hostId: string) => {
    setSelectedHostIds(prev => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      return next;
    });
  };

  const handleCreate = () => {
    const selected = hosts.filter(h => selectedHostIds.has(h.id));
    onCreate(name, selected);
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
        setName('');
        setSearch('');
        setSelectedHostIds(new Set());
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md flex flex-col max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t('dialog.createWorkspace.title', 'Create Workspace')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 flex flex-col min-h-0">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">{t('field.name', 'Name')}</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('placeholder.workspaceName', 'Workspace Name')}
              autoFocus
            />
          </div>

          <div className="space-y-2 flex-1 flex flex-col min-h-0">
            <Label>{t('field.selectHosts', 'Select Hosts')}</Label>
            <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                placeholder={t('placeholder.searchHosts', 'Search hosts...')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                />
            </div>

            <div className="border rounded-md flex-1 min-h-[200px]">
                <ScrollArea className="h-full max-h-[300px]">
                    <div className="p-2 space-y-1">
                        {filteredHosts.length === 0 ? (
                            <div className="text-center py-4 text-sm text-muted-foreground">
                                {t('common.noResults', 'No hosts found')}
                            </div>
                        ) : (
                            filteredHosts.map(host => {
                                const isSelected = selectedHostIds.has(host.id);
                                return (
                                    <div
                                        key={host.id}
                                        className={`flex items-center gap-3 p-2 rounded-md cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-primary/10' : ''}`}
                                        onClick={() => toggleHost(host.id)}
                                    >
                                        <div className={`h-4 w-4 border rounded flex items-center justify-center ${isSelected ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                                            {isSelected && <div className="h-2 w-2 bg-primary-foreground rounded-sm" />}
                                        </div>
                                        <DistroAvatar host={host} size="sm" fallback={host.label.slice(0, 2).toUpperCase()} />
                                        <div className="flex-1 min-w-0">
                                            <div className="font-medium truncate">{host.label}</div>
                                            <div className="text-xs text-muted-foreground truncate">{host.hostname}</div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </ScrollArea>
            </div>
            <div className="text-xs text-muted-foreground text-right">
                {selectedHostIds.size} {t('common.selected', 'selected')}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={handleCreate} disabled={!name.trim() || selectedHostIds.size === 0}>
            {t('common.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
