import { CheckSquare, ChevronDown, Clock, Copy, Download, Edit2, FileCode, FolderPlus, LayoutGrid, List as ListIcon, Package, Play, Plus, Search, Square, Trash2, Upload, X, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useStoredViewMode } from '../application/state/useStoredViewMode';
import { STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE } from '../infrastructure/config/storageKeys';
import { cn, isMacPlatform } from '../lib/utils';
import { Host, ProxyProfile, ShellHistoryEntry, Snippet, SSHKey } from '../types';
import { HotkeyScheme, KeyBinding, keyEventToString, ManagedSource, matchesKeyBinding, parseKeyCombo } from '../domain/models';
import {
  buildSnippetExportPayload,
  combineSnippetImportPayloads,
  mergeSnippetImportPayload,
  parseSnippetImportPayload,
  type SnippetExportPayload,
  type SnippetImportConflictAction,
} from '../domain/snippetTransfer';
import { getRunnableHostsForSnippet, snippetHasRunTargets } from '../domain/snippetTargets.ts';
import { removeHostConnectScript, syncHostsForSnippetTargetChange } from '../domain/hostConnectScripts.ts';
import { DEFAULT_SCRIPT_TEMPLATE, isScriptSnippet } from '../domain/snippetScript.ts';
import { reorderVaultItems, reorderVaultStrings, sortByVaultOrder } from '../domain/vaultOrder';
import { Button } from './ui/button';
import { ComboboxOption } from './ui/combobox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Dropdown, DropdownContent, DropdownTrigger } from './ui/dropdown';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { toast } from './ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { SnippetsRightPanel } from './SnippetsRightPanel';
import { SnippetsPackageDialogs } from './SnippetsPackageDialogs';
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from './vault/VaultPageHeader';
import {
  VaultEntityIcon,
  vaultAutomationScriptIconClass,
  vaultPrimaryIconClass,
  vaultSnippetIconClass,
} from './vault/VaultEntityIcon';
import {
  clearVaultDropIndicator as clearSnippetDropIndicator,
  getVaultDropIntent as getPackageDropIntent,
  getVaultDropPosition as getDropPosition,
  hasVaultDragType as hasDragType,
  markVaultDropIndicator as markSnippetDropIndicator,
  markVaultInsideDropIndicator as markSnippetInsideIndicator,
  useVaultGridLayoutAnimation,
} from './vault/vaultReorderDrag';

interface SnippetsManagerProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  customGroups?: string[];
  shellHistory: ShellHistoryEntry[];
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  onSave: (snippet: Snippet) => void;
  onBulkSave: (snippets: Snippet[]) => void;
  onDelete: (id: string) => void;
  onPackagesChange: (packages: string[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
  availableKeys?: SSHKey[];
  proxyProfiles?: ProxyProfile[];
  managedSources?: ManagedSource[];
  onSaveHost?: (host: Host) => void;
  onUpdateHosts?: (hosts: Host[]) => void;
  onCreateGroup?: (groupPath: string) => void;
  openSnippetId?: string | null;
  openSnippetRequestId?: number | null;
  onOpenSnippetIdHandled?: () => void;
}

type RightPanelMode = 'none' | 'edit-snippet' | 'history' | 'select-targets';

const HISTORY_PAGE_SIZE = 30;

type PendingSnippetImport = {
  fileName: string;
  fileCount: number;
  payload: SnippetExportPayload;
  conflicts: number;
};

export const SNIPPET_IMPORT_EXAMPLE_JSON = `{
  "kind": "netcatty.snippets",
  "version": 1,
  "snippets": [
    {
      "label": "Check Disk Space",
      "command": "df -h",
      "package": "ops"
    }
  ]
}`;

export type SnippetImportSampleFile = {
  name: string;
  content: string;
};

const stringifySample = (value: unknown) => JSON.stringify(value, null, 2);

export const SNIPPET_IMPORT_SAMPLE_FILES: SnippetImportSampleFile[] = [
  {
    name: "01-standard-netcatty-object.json",
    content: stringifySample({
      kind: "netcatty.snippets",
      version: 1,
      exportedAt: "2026-06-23T00:00:00.000Z",
      snippetPackages: ["ops", "ops/linux"],
      snippets: [
        {
          label: "Show Kernel",
          command: "uname -a",
          package: "ops/linux",
          tags: ["linux", "system"],
        },
        {
          label: "Memory Usage",
          command: "free -h",
          package: "ops/linux",
          tags: ["linux"],
        },
      ],
    }),
  },
  {
    name: "02-plain-snippet-array.json",
    content: stringifySample([
      {
        label: "List Listening Ports",
        command: "ss -lntp",
        package: "network",
        tags: ["network"],
      },
      {
        label: "Current Directory",
        command: "pwd",
      },
    ]),
  },
  {
    name: "03-more-snippets-for-multi-select.json",
    content: stringifySample({
      kind: "netcatty.snippets",
      version: 1,
      exportedAt: "2026-06-23T00:00:00.000Z",
      snippetPackages: ["containers", "logs"],
      snippets: [
        {
          label: "Docker Containers",
          command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
          package: "containers",
          tags: ["docker"],
        },
        {
          label: "Journal Errors",
          command: "journalctl -p err -n 50 --no-pager",
          package: "logs",
          tags: ["logs"],
        },
      ],
    }),
  },
  {
    name: "04-duplicate-command-conflict.json",
    content: stringifySample({
      kind: "netcatty.snippets",
      version: 1,
      exportedAt: "2026-06-23T00:00:00.000Z",
      snippetPackages: ["conflicts"],
      snippets: [
        {
          label: "Duplicate Check Disk Space",
          command: "df -h",
          package: "conflicts",
          tags: ["duplicate"],
        },
      ],
    }),
  },
  {
    name: "05-host-bindings-ignored.json",
    content: stringifySample({
      kind: "netcatty.snippets",
      version: 1,
      exportedAt: "2026-06-23T00:00:00.000Z",
      snippetPackages: ["security"],
      snippets: [
        {
          label: "Who Is Logged In",
          command: "who",
          package: "security",
          tags: ["audit"],
          targets: ["host-that-should-not-import"],
        },
      ],
    }),
  },
];

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
};

const pushUint16 = (parts: number[], value: number) => {
  parts.push(value & 0xff, (value >>> 8) & 0xff);
};

const pushUint32 = (parts: number[], value: number) => {
  parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

export const buildSnippetImportSamplesZip = (files: SnippetImportSampleFile[] = SNIPPET_IMPORT_SAMPLE_FILES): Blob => {
  const encoder = new TextEncoder();
  const chunks: Array<Uint8Array> = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = encoder.encode(`${file.content}\n`);
    const checksum = crc32(contentBytes);

    const localHeader: number[] = [];
    pushUint32(localHeader, 0x04034b50);
    pushUint16(localHeader, 20);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint32(localHeader, checksum);
    pushUint32(localHeader, contentBytes.length);
    pushUint32(localHeader, contentBytes.length);
    pushUint16(localHeader, nameBytes.length);
    pushUint16(localHeader, 0);
    const localChunk = new Uint8Array([...localHeader, ...nameBytes, ...contentBytes]);
    chunks.push(localChunk);

    const centralHeader: number[] = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, checksum);
    pushUint32(centralHeader, contentBytes.length);
    pushUint32(centralHeader, contentBytes.length);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, 0);
    pushUint32(centralHeader, offset);
    centralDirectory.push(new Uint8Array([...centralHeader, ...nameBytes]));

    offset += localChunk.length;
  });

  const centralDirectorySize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
  const endRecord: number[] = [];
  pushUint32(endRecord, 0x06054b50);
  pushUint16(endRecord, 0);
  pushUint16(endRecord, 0);
  pushUint16(endRecord, files.length);
  pushUint16(endRecord, files.length);
  pushUint32(endRecord, centralDirectorySize);
  pushUint32(endRecord, offset);
  pushUint16(endRecord, 0);

  return new Blob([...chunks, ...centralDirectory, new Uint8Array(endRecord)], {
    type: "application/zip",
  });
};

type SnippetsT = ReturnType<typeof useI18n>['t'];

type SnippetImportDialogProps = {
  open: boolean;
  pendingImport: PendingSnippetImport | null;
  t: SnippetsT;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onChooseFile: () => void;
  onDownloadExamples: () => void;
  onConfirmSkip: () => void;
  onConfirmOverwrite: () => void;
};

type SnippetImportDialogContentProps = Omit<SnippetImportDialogProps, "open" | "onOpenChange"> & {
  onCancel: () => void;
};

export const SnippetImportDialogContent: React.FC<SnippetImportDialogContentProps> = ({
  pendingImport,
  t,
  fileInputRef,
  onFileSelected,
  onChooseFile,
  onDownloadExamples,
  onConfirmSkip,
  onConfirmOverwrite,
  onCancel,
}) => (
  <>
    <DialogHeader>
      <DialogTitle>{t('snippets.import.modal.title')}</DialogTitle>
      <DialogDescription>{t('snippets.import.modal.desc')}</DialogDescription>
    </DialogHeader>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".json,application/json"
        multiple
        onChange={onFileSelected}
      />

    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('snippets.import.modal.exampleTitle')}
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDownloadExamples}>
            <Download size={12} className="mr-1" /> {t('snippets.import.modal.downloadExamples')}
          </Button>
        </div>
        <pre className="max-h-48 overflow-auto rounded-md bg-background/80 p-3 text-xs leading-relaxed text-muted-foreground">
          <code>{SNIPPET_IMPORT_EXAMPLE_JSON}</code>
        </pre>
      </div>

      <div className="rounded-lg border border-border/60 p-3">
        {pendingImport ? (
          <div className="space-y-1 text-sm">
            <div className="font-medium">{pendingImport.fileName}</div>
            <div className="text-xs text-muted-foreground">
              {t('snippets.import.modal.parsedSummary', {
                files: pendingImport.fileCount,
                total: pendingImport.payload.snippets.length,
                packages: pendingImport.payload.snippetPackages.length,
                conflicts: pendingImport.conflicts,
              })}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            {t('snippets.import.modal.noFile')}
          </div>
        )}
      </div>
    </div>

    <DialogFooter>
      <Button variant="ghost" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button variant="secondary" onClick={onChooseFile}>
        <Upload size={14} className="mr-1" /> {t('snippets.import.modal.chooseFile')}
      </Button>
      {pendingImport?.conflicts ? (
        <>
          <Button variant="secondary" onClick={onConfirmSkip}>
            {t('snippets.import.conflict.skip')}
          </Button>
          <Button onClick={onConfirmOverwrite}>
            {t('snippets.import.conflict.overwrite')}
          </Button>
        </>
      ) : (
        <Button disabled={!pendingImport} onClick={onConfirmSkip}>
          {t('snippets.import.modal.confirm')}
        </Button>
      )}
    </DialogFooter>
  </>
);

export const SnippetImportDialog: React.FC<SnippetImportDialogProps> = ({
  open,
  pendingImport,
  t,
  fileInputRef,
  onOpenChange,
  onFileSelected,
  onChooseFile,
  onDownloadExamples,
  onConfirmSkip,
  onConfirmOverwrite,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl">
      <SnippetImportDialogContent
        pendingImport={pendingImport}
        t={t}
        fileInputRef={fileInputRef}
        onFileSelected={onFileSelected}
        onChooseFile={onChooseFile}
        onDownloadExamples={onDownloadExamples}
        onConfirmSkip={onConfirmSkip}
        onConfirmOverwrite={onConfirmOverwrite}
        onCancel={() => onOpenChange(false)}
      />
    </DialogContent>
  </Dialog>
);

const sanitizeTransferFileNamePart = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return normalized.slice(0, 80) || 'snippets';
};

const SnippetsManager: React.FC<SnippetsManagerProps> = ({
  snippets,
  packages,
  hosts,
  customGroups = [],
  shellHistory,
  hotkeyScheme,
  keyBindings,
  onSave,
  onBulkSave,
  onDelete,
  onPackagesChange,
  onRunSnippet,
  availableKeys = [],
  proxyProfiles = [],
  managedSources = [],
  onSaveHost,
  onUpdateHosts,
  onCreateGroup,
  openSnippetId = null,
  openSnippetRequestId = null,
  onOpenSnippetIdHandled,
}) => {
  const { t } = useI18n();
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('none');
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>({
    label: '',
    command: '',
    package: '',
    targets: [],
  });
  const [targetSelection, setTargetSelection] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [newPackageName, setNewPackageName] = useState('');
  const [isPackageDialogOpen, setIsPackageDialogOpen] = useState(false);

  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renamingPackagePath, setRenamingPackagePath] = useState<string | null>(null);
  const [renamePackageName, setRenamePackageName] = useState('');
  const [renameError, setRenameError] = useState('');

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE,
    'grid',
  );
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const listRef = useRef<HTMLDivElement | null>(null);
  const snippetImportInputRef = useRef<HTMLInputElement | null>(null);
  const lastPreviewReorderRef = useRef<string | null>(null);
  const draggingSnippetIdRef = useRef<string | null>(null);
  const draggingPackagePathRef = useRef<string | null>(null);
  const [draggingSnippetId, setDraggingSnippetId] = useState<string | null>(null);
  const [draggingPackagePath, setDraggingPackagePath] = useState<string | null>(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedSnippetIds, setSelectedSnippetIds] = useState<Set<string>>(new Set());
  const [isSnippetImportDialogOpen, setIsSnippetImportDialogOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingSnippetImport | null>(null);
  const prepareGridLayoutAnimation = useVaultGridLayoutAnimation(listRef);

  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const [isRecordingShortkey, setIsRecordingShortkey] = useState(false);
  const [shortkeyError, setShortkeyError] = useState<string | null>(null);

  const existingShortkeys = useMemo(() => (
    snippets.filter(s => Boolean(s.shortkey) && s.id !== editingSnippet.id)
  ), [snippets, editingSnippet.id]);

  const isMac = useMemo(() => (
    hotkeyScheme === 'mac' || (hotkeyScheme === 'disabled' && isMacPlatform())
  ), [hotkeyScheme]);

  const activeSystemBindings = useMemo(() => {
    return keyBindings.flatMap((binding) => {
      const entries: { binding: string; isMac: boolean }[] = [];
      const macBinding = binding.mac;
      const pcBinding = binding.pc;

      if (hotkeyScheme === 'mac') {
        if (macBinding && macBinding !== 'Disabled') {
          entries.push({ binding: macBinding, isMac: true });
        }
        return entries;
      }

      if (hotkeyScheme === 'pc') {
        if (pcBinding && pcBinding !== 'Disabled') {
          entries.push({ binding: pcBinding, isMac: false });
        }
        return entries;
      }

      if (macBinding && macBinding !== 'Disabled') {
        entries.push({ binding: macBinding, isMac: true });
      }
      if (pcBinding && pcBinding !== 'Disabled') {
        entries.push({ binding: pcBinding, isMac: false });
      }
      return entries;
    });
  }, [hotkeyScheme, keyBindings]);

  const buildKeyEventFromString = useCallback((keyString: string) => {
    const parsed = parseKeyCombo(keyString);
    if (!parsed) return null;

    const modifiers = new Set(parsed.modifiers);
    const key = parsed.key;
    const normalizedKey = (() => {
      switch (key) {
        case 'Space':
          return ' ';
        case '↑':
          return 'ArrowUp';
        case '↓':
          return 'ArrowDown';
        case '←':
          return 'ArrowLeft';
        case '→':
          return 'ArrowRight';
        case 'Esc':
          return 'Escape';
        case '⌫':
          return 'Backspace';
        case 'Del':
          return 'Delete';
        case '↵':
          return 'Enter';
        case '⇥':
          return 'Tab';
        default:
          return key.length === 1 ? key.toLowerCase() : key;
      }
    })();

    return new KeyboardEvent('keydown', {
      key: normalizedKey,
      metaKey: modifiers.has('⌘') || modifiers.has('Win'),
      ctrlKey: modifiers.has('⌃') || modifiers.has('Ctrl'),
      altKey: modifiers.has('⌥') || modifiers.has('Alt'),
      shiftKey: modifiers.has('Shift'),
    });
  }, []);

  const normalizeKeyString = useCallback((value: string) => (
    value.toLowerCase().replace(/\s+/g, '')
  ), []);

  const validateShortkey = useCallback((key: string): string | null => {
    if (!key) return null;
    
    const syntheticEvent = buildKeyEventFromString(key);
    if (syntheticEvent) {
      const conflictsSystem = activeSystemBindings.some(({ binding, isMac: bindingIsMac }) => (
        matchesKeyBinding(syntheticEvent, binding, bindingIsMac)
      ));
      if (conflictsSystem) {
        return t('snippets.shortkey.error.systemConflict');
      }
    }
    
    if (syntheticEvent) {
      for (const snippet of existingShortkeys) {
        if (snippet.shortkey && matchesKeyBinding(syntheticEvent, snippet.shortkey, isMac)) {
          return t('snippets.shortkey.error.snippetConflict', { name: snippet.label });
        }
      }
    } else {
      const normalizedKey = normalizeKeyString(key);
      const conflictingSnippet = existingShortkeys.find(snippet => (
        snippet.shortkey && normalizeKeyString(snippet.shortkey) === normalizedKey
      ));
      if (conflictingSnippet) {
        return t('snippets.shortkey.error.snippetConflict', { name: conflictingSnippet.label });
      }
    }
    
    return null;
  }, [
    activeSystemBindings,
    buildKeyEventFromString,
    existingShortkeys,
    isMac,
    normalizeKeyString,
    t,
  ]);

  useEffect(() => {
    if (!isRecordingShortkey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setIsRecordingShortkey(false);
        setShortkeyError(null);
        return;
      }

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyString = keyEventToString(e, isMac);
      
      const error = validateShortkey(keyString);
      if (error) {
        setShortkeyError(error);
        return;
      }
      
      setShortkeyError(null);
      setEditingSnippet(prev => ({ ...prev, shortkey: keyString }));
      setIsRecordingShortkey(false);
    };

    const handleClick = () => {
      setIsRecordingShortkey(false);
      setShortkeyError(null);
    };

    const timer = setTimeout(() => {
      window.addEventListener('click', handleClick, true);
    }, 100);

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [isRecordingShortkey, isMac, validateShortkey]);

  const handleEdit = useCallback((snippet?: Snippet, asScript = false) => {
    if (snippet) {
      setEditingSnippet(snippet);
      setTargetSelection(snippet.targetsAllHosts ? [] : (snippet.targets || []));
    } else {
      setEditingSnippet(asScript ? {
        label: '',
        command: DEFAULT_SCRIPT_TEMPLATE,
        package: selectedPackage || '',
        targets: [],
        kind: 'script',
        language: 'javascript',
        trigger: 'manual',
      } : {
        label: '',
        command: '',
        package: selectedPackage || '',
        targets: [],
      });
      setTargetSelection([]);
    }
    setRightPanelMode('edit-snippet');
  }, [selectedPackage]);

  useEffect(() => {
    if (!openSnippetId) return;
    const snippet = snippets.find((item) => item.id === openSnippetId);
    if (!snippet) return;
    handleEdit(snippet);
    onOpenSnippetIdHandled?.();
  }, [handleEdit, onOpenSnippetIdHandled, openSnippetId, openSnippetRequestId, snippets]);


  const buildSavedSnippet = useCallback((): Snippet | null => {
    if (!editingSnippet.label || !editingSnippet.command) return null;
    return {
      id: editingSnippet.id || crypto.randomUUID(),
      label: editingSnippet.label,
      command: editingSnippet.command,
      tags: editingSnippet.tags || [],
      package: editingSnippet.package || '',
      targets: editingSnippet.targetsAllHosts ? [] : targetSelection,
      targetsAllHosts: editingSnippet.targetsAllHosts || undefined,
      shortkey: editingSnippet.shortkey,
      noAutoRun: editingSnippet.noAutoRun,
      order: editingSnippet.order,
      kind: editingSnippet.kind,
      language: editingSnippet.language,
      description: editingSnippet.description,
      trigger: editingSnippet.trigger,
      triggerPattern: editingSnippet.triggerPattern,
    };
  }, [editingSnippet, targetSelection]);

  const syncHostsAfterSnippetSave = useCallback((
    savedSnippet: Snippet,
    nextSnippets: Snippet[],
  ) => {
    if (!onUpdateHosts || !savedSnippet.id) return;
    const original = snippets.find((item) => item.id === savedSnippet.id);
    const prevTargetIds = original?.targetsAllHosts ? [] : (original?.targets ?? []);
    let nextHosts = hosts;

    if (isScriptSnippet(savedSnippet) && savedSnippet.trigger === 'onConnect') {
      nextHosts = syncHostsForSnippetTargetChange(hosts, savedSnippet, prevTargetIds, nextSnippets);
    } else if (original && isScriptSnippet(original) && original.trigger === 'onConnect') {
      nextHosts = hosts.map((item) => removeHostConnectScript(item, savedSnippet.id!, nextSnippets));
    }

    const changed = nextHosts.length !== hosts.length
      || nextHosts.some((host, index) => host !== hosts[index]);
    if (changed) {
      onUpdateHosts(nextHosts);
    }
  }, [hosts, onUpdateHosts, snippets]);

  const handleSave = useCallback(() => {
    const savedSnippet = buildSavedSnippet();
    if (!savedSnippet) return;
    const nextSnippets = snippets.find((ex) => ex.id === savedSnippet.id)
      ? snippets.map((ex) => (ex.id === savedSnippet.id ? savedSnippet : ex))
      : [...snippets, savedSnippet];
    onSave(savedSnippet);
    syncHostsAfterSnippetSave(savedSnippet, nextSnippets);
    setRightPanelMode('none');
  }, [buildSavedSnippet, onSave, snippets, syncHostsAfterSnippetSave]);

  const handleSaveAndRun = useCallback(() => {
    const savedSnippet = buildSavedSnippet();
    if (!savedSnippet) return;
    const nextSnippets = snippets.find((ex) => ex.id === savedSnippet.id)
      ? snippets.map((ex) => (ex.id === savedSnippet.id ? savedSnippet : ex))
      : [...snippets, savedSnippet];
    onSave(savedSnippet);
    syncHostsAfterSnippetSave(savedSnippet, nextSnippets);
    const runTargets = getRunnableHostsForSnippet(savedSnippet, hosts);
    if (snippetHasRunTargets(savedSnippet) && runTargets.length > 0) {
      onRunSnippet?.(savedSnippet, runTargets);
    }
    setRightPanelMode('none');
  }, [buildSavedSnippet, hosts, onRunSnippet, onSave, snippets, syncHostsAfterSnippetSave]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (rightPanelMode !== 'edit-snippet') return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      handleSave();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, rightPanelMode]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleClosePanel = () => {
    setRightPanelMode('none');
    setEditingSnippet({ label: '', command: '', package: '', targets: [] });
    setTargetSelection([]);
  };

  const hostById = useMemo(() => (
    new Map(hosts.map((host) => [host.id, host]))
  ), [hosts]);

  const targetHosts = useMemo(() => {
    return targetSelection
      .map((id) => hostById.get(id))
      .filter((h): h is Host => Boolean(h));
  }, [targetSelection, hostById]);

  const openTargetPicker = () => {
    setRightPanelMode('select-targets');
  };

  const handleTargetSelect = (host: Host) => {
    if (editingSnippet.targetsAllHosts) {
      setEditingSnippet((prev) => ({ ...prev, targetsAllHosts: undefined }));
    }
    setTargetSelection((prev) => {
      const next = prev.includes(host.id) ? prev.filter((id) => id !== host.id) : [...prev, host.id];
      setEditingSnippet((snippet) => ({
        ...snippet,
        targetsAllHosts: undefined,
        targets: next,
      }));
      return next;
    });
  };

  const handleTargetPickerBack = () => {
    setRightPanelMode('edit-snippet');
  };

  const snippetPackageDescendantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    snippets.forEach((snippet) => {
      const pkg = snippet.package || '';
      if (!pkg) return;

      if (pkg.startsWith('/')) {
        const parts = pkg.substring(1).split('/').filter(Boolean);
        for (let index = 0; index < parts.length; index += 1) {
          const path = `/${parts.slice(0, index + 1).join('/')}`;
          counts.set(path, (counts.get(path) ?? 0) + 1);
        }
        return;
      }

      const parts = pkg.split('/').filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const path = parts.slice(0, index + 1).join('/');
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    });
    return counts;
  }, [snippets]);

  const displayedPackages = useMemo(() => {
    const packageIndexByPath = new Map(packages.map((pkg, index) => [pkg, index]));
    const getPackageDisplayOrder = (path: string) => {
      const exactIndex = packageIndexByPath.get(path);
      if (typeof exactIndex === 'number') return exactIndex;
      const childIndex = packages.findIndex((pkg) => pkg.startsWith(path + '/'));
      return childIndex >= 0 ? childIndex : Number.MAX_SAFE_INTEGER;
    };
    const sortBySavedPackageOrder = (
      items: { name: string; path: string; count: number }[],
    ) => {
      return [...items].sort((a, b) => {
        const orderDiff = getPackageDisplayOrder(a.path) - getPackageDisplayOrder(b.path);
        if (orderDiff !== 0) return orderDiff;
        return a.name.localeCompare(b.name);
      });
    };

    if (!selectedPackage) {
      const absolutePaths = packages.filter(p => p.startsWith('/'));
      const relativePaths = packages.filter(p => !p.startsWith('/'));
      
      const results: { name: string; path: string; count: number }[] = [];
      
      const relativeRoots = relativePaths
        .map((p) => p.split('/')[0])
        .filter((name): name is string => Boolean(name) && name.length > 0);
      
      Array.from(new Set(relativeRoots)).forEach((name: string) => {
        const path: string = name;
        const count = snippetPackageDescendantCounts.get(path) ?? 0;
        results.push({ name, path, count });
      });
      
      const absoluteRoots = absolutePaths
        .map((p) => {
          const cleanPath = p.substring(1); // Remove leading slash
          const firstSegment = cleanPath.split('/')[0];
          return firstSegment;
        })
        .filter((name): name is string => Boolean(name) && name.length > 0);
      
      Array.from(new Set(absoluteRoots)).forEach((name: string) => {
        const path: string = `/${name}`;
        const displayName: string = `/${name}`; // Show with leading slash to distinguish
        const count = snippetPackageDescendantCounts.get(path) ?? 0;
        results.push({ name: displayName, path, count });
      });
      
      return sortBySavedPackageOrder(results);
    }
    
    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter((name): name is string => Boolean(name) && name.length > 0);
    return sortBySavedPackageOrder(Array.from(new Set<string>(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      const count = snippetPackageDescendantCounts.get(path) ?? 0;
      return { name, path, count };
    }));
  }, [packages, selectedPackage, snippetPackageDescendantCounts]);

  const displayedSnippets = useMemo(() => {
    const hasSearch = search.trim().length > 0;
    let result = hasSearch
      ? snippets
      : snippets.filter((s) => (s.package || '') === (selectedPackage || ''));
    if (hasSearch) {
      const s = search.toLowerCase();
      result = result.filter(sn =>
        sn.label.toLowerCase().includes(s) ||
        sn.command.toLowerCase().includes(s)
      );
    }
    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'manual':
          return 0;
        default:
          return 0;
      }
    });
    return sortMode === 'manual' ? sortByVaultOrder(result) : result;
  }, [snippets, selectedPackage, search, sortMode]);

  const isSearchActive = search.trim().length > 0;

  useEffect(() => {
    setSelectedSnippetIds((prev) => {
      const existingIds = new Set(snippets.map((snippet) => snippet.id));
      const next = new Set(Array.from(prev).filter((id) => existingIds.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [snippets]);

  const clearSnippetSelection = useCallback(() => {
    setSelectedSnippetIds(new Set());
    setIsMultiSelectMode(false);
  }, []);

  const toggleSnippetSelection = useCallback((id: string) => {
    setSelectedSnippetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectVisibleSnippets = useCallback(() => {
    setSelectedSnippetIds(new Set(displayedSnippets.map((snippet) => snippet.id)));
  }, [displayedSnippets]);

  const getSnippetsInPackage = useCallback(
    (path: string) => (
      snippets.filter((snippet) => {
        const packagePath = snippet.package || '';
        return packagePath === path || packagePath.startsWith(`${path}/`);
      })
    ),
    [snippets],
  );

  const downloadSnippetPayload = useCallback((payload: SnippetExportPayload, fileNamePart: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netcatty-snippets-${sanitizeTransferFileNamePart(fileNamePart)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const downloadSnippetImportExamples = useCallback(() => {
    const blob = buildSnippetImportSamplesZip();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'netcatty-snippet-import-samples.zip';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportSnippetList = useCallback(
    (items: Snippet[], fileNamePart: string) => {
      if (items.length === 0) {
        toast.warning(t('snippets.export.toast.empty'));
        return;
      }
      const payload = buildSnippetExportPayload({
        snippets: items,
        snippetPackages: packages,
      });
      downloadSnippetPayload(payload, fileNamePart);
      toast.success(
        t('snippets.export.toast.success', { count: items.length }),
        t('snippets.export.toast.successTitle'),
      );
    },
    [downloadSnippetPayload, packages, t],
  );

  const exportSingleSnippet = useCallback(
    (snippet: Snippet) => {
      exportSnippetList([snippet], snippet.label);
    },
    [exportSnippetList],
  );

  const exportPackageSnippets = useCallback(
    (path: string) => {
      exportSnippetList(getSnippetsInPackage(path), path);
    },
    [exportSnippetList, getSnippetsInPackage],
  );

  const exportSelectedSnippets = useCallback(() => {
    const selected = snippets.filter((snippet) => selectedSnippetIds.has(snippet.id));
    exportSnippetList(selected, `selected-${selected.length}`);
  }, [exportSnippetList, selectedSnippetIds, snippets]);

  const applySnippetImport = useCallback(
    (payload: SnippetExportPayload, conflictAction: SnippetImportConflictAction) => {
      const result = mergeSnippetImportPayload({
        existingSnippets: snippets,
        existingSnippetPackages: packages,
        payload,
        conflictAction,
        createId: () => crypto.randomUUID(),
      });
      onBulkSave(result.snippets);
      onPackagesChange(result.snippetPackages);
      setPendingImport(null);
      setIsSnippetImportDialogOpen(false);
      toast.success(
        t('snippets.import.toast.summary', {
          imported: result.stats.imported,
          overwritten: result.stats.overwritten,
          skipped: result.stats.skipped,
        }),
        t('snippets.import.toast.successTitle'),
      );
    },
    [onBulkSave, onPackagesChange, packages, snippets, t],
  );

  const handleSnippetImportFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;

      try {
        const payloads = await Promise.all(
          files.map(async (file) => parseSnippetImportPayload(await file.text())),
        );
        const payload = combineSnippetImportPayloads(payloads);
        if (payload.snippets.length === 0) {
          toast.warning(t('snippets.import.toast.empty'));
          setPendingImport(null);
          return;
        }

        const existingCommands = new Set(snippets.map((snippet) => snippet.command));
        const conflicts = payload.snippets.filter((snippet) => existingCommands.has(snippet.command)).length;
        const fileName = files.length === 1
          ? files[0].name
          : t('snippets.import.modal.multipleFiles', { count: files.length });
        setPendingImport({ fileName, fileCount: files.length, payload, conflicts });
      } catch {
        setPendingImport(null);
        toast.error(
          t('snippets.import.toast.invalidDesc'),
          t('snippets.import.toast.failedTitle'),
        );
      }
    },
    [snippets, t],
  );

  const breadcrumb = useMemo(() => {
    if (!selectedPackage) return [];
    const isAbsolute = selectedPackage.startsWith('/');
    const parts = selectedPackage.split('/').filter(Boolean);
    return parts.map((name, idx) => {
      const pathSegments = parts.slice(0, idx + 1);
      const path = isAbsolute ? `/${pathSegments.join('/')}` : pathSegments.join('/');
      return { name, path };
    });
  }, [selectedPackage]);

  const createPackage = () => {
    const name = newPackageName.trim();
    if (!name) return;
    
    if (!/^\/?([\w\p{L}\p{N}-]+(\/[\w\p{L}\p{N}-]+)*)\/?$/u.test(name)) {
      return;
    }
    
    let full: string;
    if (selectedPackage) {
      const normalizedName = name.startsWith('/') ? name.substring(1) : name;
      full = `${selectedPackage}/${normalizedName}`;
    } else {
      full = name;
    }

    if (full.endsWith('/')) {
      full = full.slice(0, -1);
    }
    
    const existingPackage = packages.find(p => p.toLowerCase() === full.toLowerCase());
    if (existingPackage) {
      return;
    }
    
    onPackagesChange([...packages, full]);
    setNewPackageName('');
    setIsPackageDialogOpen(false);
  };

  const deletePackage = (path: string) => {
    const keep = packages.filter((p) => !(p === path || p.startsWith(path + '/')));
    
    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === path || s.package.startsWith(path + '/')) {
        return { ...s, package: '' };
      }
      return s;
    });
    
    onPackagesChange(keep);
    
    onBulkSave(updatedSnippets);
    
    if (selectedPackage && (selectedPackage === path || selectedPackage.startsWith(path + '/'))) {
      setSelectedPackage(null);
    }
  };

  const movePackage = (source: string, target: string | null) => {
    const name = source.split('/').pop() || '';
    const isAbsolute = source.startsWith('/');
    const newPath = target ? `${target}/${name}` : (isAbsolute ? `/${name}` : name);
    if (newPath === source || newPath.startsWith(source + '/')) return;

    if (packages.includes(newPath)) return;

    const updatedPackages = packages.map((p) => {
      if (p === source) return newPath;
      if (p.startsWith(source + '/')) {
        return newPath + p.substring(source.length);
      }
      return p;
    });

    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === source) return { ...s, package: newPath };
      if (s.package.startsWith(source + '/')) {
        return { ...s, package: newPath + s.package.substring(source.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    onBulkSave(updatedSnippets);
    if (selectedPackage === source) setSelectedPackage(newPath);
  };

  const openRenameDialog = (path: string) => {
    const name = path.split('/').pop() || '';
    setRenamingPackagePath(path);
    setRenamePackageName(name);
    setRenameError('');
    setIsRenameDialogOpen(true);
  };

  const renamePackage = () => {
    if (!renamingPackagePath) return;

    const newName = renamePackageName.trim();

    if (!newName) {
      setRenameError(t('snippets.renameDialog.error.empty'));
      return;
    }

    if (!/^[\w\p{L}\p{N}-]+$/u.test(newName)) {
      setRenameError(t('snippets.renameDialog.error.invalidChars'));
      return;
    }

    const parts = renamingPackagePath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    if (newPath === renamingPackagePath) {
      setIsRenameDialogOpen(false);
      return;
    }

    const existingPackage = packages.find(p => p !== renamingPackagePath && p.toLowerCase() === newPath.toLowerCase());
    if (existingPackage) {
      setRenameError(t('snippets.renameDialog.error.duplicate'));
      return;
    }

    const updatedPackages = packages.map((p) => {
      if (p === renamingPackagePath) return newPath;
      if (p.startsWith(renamingPackagePath + '/')) {
        return newPath + p.substring(renamingPackagePath.length);
      }
      return p;
    });

    const updatedSnippets = snippets.map((s) => {
      if (!s.package) return s;
      if (s.package === renamingPackagePath) return { ...s, package: newPath };
      if (s.package.startsWith(renamingPackagePath + '/')) {
        return { ...s, package: newPath + s.package.substring(renamingPackagePath.length) };
      }
      return s;
    });

    onPackagesChange(Array.from(new Set(updatedPackages)));
    onBulkSave(updatedSnippets);

    if (selectedPackage === renamingPackagePath) {
      setSelectedPackage(newPath);
    } else if (selectedPackage?.startsWith(renamingPackagePath + '/')) {
      setSelectedPackage(newPath + selectedPackage.substring(renamingPackagePath.length));
    }

    if (editingSnippet.package) {
      if (editingSnippet.package === renamingPackagePath) {
        setEditingSnippet(prev => ({ ...prev, package: newPath }));
      } else if (editingSnippet.package.startsWith(renamingPackagePath + '/')) {
        setEditingSnippet(prev => ({
          ...prev,
          package: newPath + prev.package!.substring(renamingPackagePath.length)
        }));
      }
    }

    setIsRenameDialogOpen(false);
  };

  const moveSnippet = (id: string, pkg: string | null) => {
    const sn = snippets.find((s) => s.id === id);
    if (!sn) return;
    onSave({ ...sn, package: pkg || '' });
  };

  const parentOfPackage = useCallback((path: string) => {
    const parts = path.split('/').filter(Boolean);
    const prefix = path.startsWith('/') ? '/' : '';
    return prefix + parts.slice(0, -1).join('/');
  }, []);

  const resetSnippetDragState = useCallback(() => {
    clearSnippetDropIndicator();
    lastPreviewReorderRef.current = null;
    draggingSnippetIdRef.current = null;
    draggingPackagePathRef.current = null;
    setDraggingSnippetId(null);
    setDraggingPackagePath(null);
  }, []);

  const handleReorderDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const target = (event.target as Element | null)?.closest('[data-snippet-id], [data-pkg-path]');
    if (!(target instanceof HTMLElement)) return;

    const isGrid = viewMode === 'grid';
    const targetSnippetId = target.getAttribute('data-snippet-id');
    const targetPackage = target.getAttribute('data-pkg-path');
    const isDraggingSnippet = Boolean(draggingSnippetIdRef.current) || hasDragType(event.dataTransfer, 'snippet-id');
    const isDraggingPackage = Boolean(draggingPackagePathRef.current) || hasDragType(event.dataTransfer, 'pkg-path');
    if (targetSnippetId && isDraggingSnippet) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const sourceSnippetId = draggingSnippetIdRef.current || event.dataTransfer.getData('snippet-id');
      const position = getDropPosition(target, event.clientX, event.clientY, isGrid);
      if (isGrid && sourceSnippetId && sourceSnippetId !== targetSnippetId) {
        const targetSnippet = snippets.find((snippet) => snippet.id === targetSnippetId);
        const sourceSnippet = snippets.find((snippet) => snippet.id === sourceSnippetId);
        if (!targetSnippet || !sourceSnippet) return;
        const previewKey = `${sourceSnippetId}:${targetSnippetId}:${position}`;
        if (lastPreviewReorderRef.current === previewKey) return;
        prepareGridLayoutAnimation();
        lastPreviewReorderRef.current = previewKey;
        const movedSnippets = snippets.map((snippet) =>
          snippet.id === sourceSnippetId
            ? { ...snippet, package: targetSnippet.package || '' }
            : snippet,
        );
        onBulkSave(reorderVaultItems(movedSnippets, sourceSnippetId, targetSnippetId, position));
        setSortMode('manual');
        return;
      }
      markSnippetDropIndicator(target, position, isGrid ? 'x' : 'y');
      return;
    }
    if (targetPackage && isDraggingSnippet) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      markSnippetInsideIndicator(target);
      return;
    }
    if (targetPackage && isDraggingPackage) {
      const sourcePackage = draggingPackagePathRef.current || event.dataTransfer.getData('pkg-path');
      if (
        sourcePackage &&
        targetPackage.startsWith(`${sourcePackage}/`)
      ) {
        event.dataTransfer.dropEffect = 'none';
        clearSnippetDropIndicator();
        return;
      }
      const intent = getPackageDropIntent(target, event.clientX, event.clientY, isGrid);
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (intent === 'inside') {
        markSnippetInsideIndicator(target);
        return;
      }
      if (
        isGrid &&
        sourcePackage &&
        parentOfPackage(sourcePackage) === parentOfPackage(targetPackage)
      ) {
        const previewKey = `package:${sourcePackage}:${targetPackage}:${intent}`;
        if (lastPreviewReorderRef.current !== previewKey) {
          prepareGridLayoutAnimation();
          lastPreviewReorderRef.current = previewKey;
          const sortablePackages = Array.from(new Set([...packages, sourcePackage, targetPackage]));
          onPackagesChange(reorderVaultStrings(sortablePackages, sourcePackage, targetPackage, intent));
          setSortMode('manual');
        }
        return;
      }
      markSnippetDropIndicator(target, intent, isGrid ? 'x' : 'y');
      return;
    }
    event.dataTransfer.dropEffect = 'none';
    clearSnippetDropIndicator();
  }, [
    onBulkSave,
    onPackagesChange,
    packages,
    parentOfPackage,
    prepareGridLayoutAnimation,
    snippets,
    viewMode,
  ]);

  const handleReorderDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const target = (event.target as Element | null)?.closest('[data-snippet-id], [data-pkg-path]');
    clearSnippetDropIndicator();
    if (!(target instanceof HTMLElement)) return;
    const isGrid = viewMode === 'grid';

    const sourceSnippetId = draggingSnippetIdRef.current || event.dataTransfer.getData('snippet-id');
    const targetSnippetId = target.getAttribute('data-snippet-id');
    if (sourceSnippetId && targetSnippetId) {
      event.preventDefault();
      event.stopPropagation();
      if (sourceSnippetId === targetSnippetId) {
        lastPreviewReorderRef.current = null;
        return;
      }
      const targetSnippet = snippets.find((snippet) => snippet.id === targetSnippetId);
      const sourceSnippet = snippets.find((snippet) => snippet.id === sourceSnippetId);
      if (!targetSnippet || !sourceSnippet) return;
      const movedSnippets = snippets.map((snippet) =>
        snippet.id === sourceSnippetId
          ? { ...snippet, package: targetSnippet.package || '' }
          : snippet,
      );
      const position = getDropPosition(target, event.clientX, event.clientY, isGrid);
      const previewKey = `${sourceSnippetId}:${targetSnippetId}:${position}`;
      if (!isGrid || lastPreviewReorderRef.current !== previewKey) {
        prepareGridLayoutAnimation();
        onBulkSave(reorderVaultItems(
          movedSnippets,
          sourceSnippetId,
          targetSnippetId,
          position,
        ));
      }
      lastPreviewReorderRef.current = null;
      setSortMode('manual');
      return;
    }

    const sourcePackage = draggingPackagePathRef.current || event.dataTransfer.getData('pkg-path');
    const targetPackage = target.getAttribute('data-pkg-path');
    if (sourcePackage && targetPackage) {
      event.preventDefault();
      event.stopPropagation();
      if (sourcePackage === targetPackage) {
        lastPreviewReorderRef.current = null;
        return;
      }
      const intent = getPackageDropIntent(target, event.clientX, event.clientY, isGrid);
      if (intent === 'inside') return;
      if (parentOfPackage(sourcePackage) !== parentOfPackage(targetPackage)) return;
      const sortablePackages = Array.from(new Set([...packages, sourcePackage, targetPackage]));
      const previewKey = `package:${sourcePackage}:${targetPackage}:${intent}`;
      if (!isGrid || lastPreviewReorderRef.current !== previewKey) {
        prepareGridLayoutAnimation();
        onPackagesChange(reorderVaultStrings(sortablePackages, sourcePackage, targetPackage, intent));
      }
      lastPreviewReorderRef.current = null;
      setSortMode('manual');
    }
  }, [
    onBulkSave,
    onPackagesChange,
    packages,
    parentOfPackage,
    prepareGridLayoutAnimation,
    snippets,
    viewMode,
  ]);

  const packageOptions: ComboboxOption[] = useMemo(() => {
    const allPaths = new Set<string>();
    
    packages.forEach(pkg => {
      allPaths.add(pkg);
      
      const parts = pkg.split('/').filter(Boolean);
      const isAbsolute = pkg.startsWith('/');
      
      for (let i = 1; i < parts.length; i++) {
        const parentPath = (isAbsolute ? '/' : '') + parts.slice(0, i).join('/');
        allPaths.add(parentPath);
      }
    });
    
    return Array.from(allPaths)
      .sort((a, b) => {
        const depthA = (a.match(/\//g) || []).length;
        const depthB = (b.match(/\//g) || []).length;
        if (depthA !== depthB) return depthA - depthB;
        return a.localeCompare(b);
      })
      .map(p => ({
        value: p,
        label: p.includes('/') ? p.split('/').pop()! : p,
        sublabel: p.includes('/') ? p : undefined,
      }));
  }, [packages]);

  const visibleHistory = useMemo(() => {
    return shellHistory.slice(0, historyVisibleCount);
  }, [shellHistory, historyVisibleCount]);

  const hasMoreHistory = historyVisibleCount < shellHistory.length;

  const loadMoreHistory = useCallback(() => {
    if (isLoadingMore || !hasMoreHistory) return;
    setIsLoadingMore(true);
    setTimeout(() => {
      setHistoryVisibleCount((prev) => Math.min(prev + HISTORY_PAGE_SIZE, shellHistory.length));
      setIsLoadingMore(false);
    }, 200);
  }, [isLoadingMore, hasMoreHistory, shellHistory.length]);

  const handleHistoryScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (scrollBottom < 100 && hasMoreHistory && !isLoadingMore) {
      loadMoreHistory();
    }
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory]);

  useEffect(() => {
    if (rightPanelMode === 'history') {
      setHistoryVisibleCount(HISTORY_PAGE_SIZE);
    }
  }, [rightPanelMode]);

  const saveHistoryAsSnippet = (entry: ShellHistoryEntry, label: string) => {
    if (!label.trim()) return;
    onSave({
      id: crypto.randomUUID(),
      label: label.trim(),
      command: entry.command,
      package: selectedPackage || '',
      targets: [],
    });
  };

  const renderRightPanel = () => (
    <SnippetsRightPanel
      rightPanelMode={rightPanelMode}
      hosts={hosts}
      customGroups={customGroups}
      targetSelection={targetSelection}
      setTargetSelection={setTargetSelection}
      handleTargetSelect={handleTargetSelect}
      handleTargetPickerBack={handleTargetPickerBack}
      availableKeys={availableKeys}
      proxyProfiles={proxyProfiles}
      managedSources={managedSources}
      onSaveHost={onSaveHost}
      onCreateGroup={onCreateGroup}
      t={t}
      handleClosePanel={handleClosePanel}
      editingSnippet={editingSnippet}
      onDelete={onDelete}
      handleSave={handleSave}
      handleSaveAndRun={handleSaveAndRun}
      setEditingSnippet={setEditingSnippet}
      packageOptions={packageOptions}
      selectedPackage={selectedPackage}
      packages={packages}
      onPackagesChange={onPackagesChange}
      shortkeyError={shortkeyError}
      setShortkeyError={setShortkeyError}
      isRecordingShortkey={isRecordingShortkey}
      setIsRecordingShortkey={setIsRecordingShortkey}
      openTargetPicker={openTargetPicker}
      targetHosts={targetHosts}
      shellHistory={shellHistory}
      handleHistoryScroll={handleHistoryScroll}
      historyScrollRef={historyScrollRef}
      visibleHistory={visibleHistory}
      saveHistoryAsSnippet={saveHistoryAsSnippet}
      handleCopy={handleCopy}
      copiedId={copiedId}
      hasMoreHistory={hasMoreHistory}
      isLoadingMore={isLoadingMore}
      loadMoreHistory={loadMoreHistory}
      onRunSnippet={onRunSnippet}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
    <div className="h-full min-h-0 flex relative">
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        <VaultPageHeader>
            <VaultHeaderSearch
              placeholder={t('snippets.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <Button onClick={() => handleEdit()} size="sm" className="h-10 px-3">
              <Plus size={14} className="mr-2" /> {t('snippets.action.newSnippet')}
            </Button>
            <Button onClick={() => handleEdit(undefined, true)} size="sm" variant="secondary" className={vaultHeaderSecondaryButtonClass}>
              <Play size={14} className="mr-2" /> {t('snippets.action.newScript')}
            </Button>
            <Button
              onClick={() => {
                setNewPackageName('');
                setIsPackageDialogOpen(true);
              }}
              size="sm"
              variant="secondary"
              className={vaultHeaderSecondaryButtonClass}
            >
              <FolderPlus size={14} className="mr-1" /> {t('snippets.action.newPackage')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={vaultHeaderSecondaryButtonClass}
              onClick={() => {
                setPendingImport(null);
                setIsSnippetImportDialogOpen(true);
              }}
            >
              <Upload size={14} className="mr-1" /> {t('snippets.action.import')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={cn(
                vaultHeaderSecondaryButtonClass,
                rightPanelMode === 'history' && "bg-foreground/10 hover:bg-foreground/15",
              )}
              onClick={() => setRightPanelMode(rightPanelMode === 'history' ? 'none' : 'history')}
            >
              <Clock size={14} /> {t('snippets.history.title')}
            </Button>
            <div className="flex items-center gap-1 ml-auto">
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" className={vaultHeaderIconButtonClass}>
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
                    <LayoutGrid size={14} /> {t('snippets.view.grid')}
                  </Button>
                  <Button
                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode('list')}
                  >
                    <ListIcon size={14} /> {t('snippets.view.list')}
                  </Button>
                </DropdownContent>
              </Dropdown>
              <SortDropdown
                value={sortMode}
                onChange={setSortMode}
                className={vaultHeaderIconButtonClass}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isMultiSelectMode ? "secondary" : "ghost"}
                    size="icon"
                    className={vaultHeaderIconButtonClass}
                    aria-label={t('snippets.action.selectSnippets')}
                    onClick={() => {
                      if (isMultiSelectMode) {
                        clearSnippetSelection();
                      } else {
                        setIsMultiSelectMode(true);
                      }
                    }}
                  >
                    <CheckSquare size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('snippets.action.selectSnippets')}</TooltipContent>
              </Tooltip>
            </div>
        </VaultPageHeader>

        {isMultiSelectMode && (
          <div className="px-4 py-1.5 bg-background border-b border-border/40 flex items-center gap-2">
            <span className="flex items-center h-7 text-xs text-muted-foreground leading-none">
              {t('snippets.selection.selected', { count: selectedSnippetIds.size })}
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={selectVisibleSnippets}
            >
              {t('snippets.selection.selectVisible')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={clearSnippetSelection}
            >
              {t('snippets.selection.deselectAll')}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={selectedSnippetIds.size === 0}
              onClick={exportSelectedSnippets}
            >
              <Download size={12} className="mr-1" />
              {t('snippets.selection.exportSelected', { count: selectedSnippetIds.size })}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearSnippetSelection}
            >
              <X size={12} />
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm font-semibold px-4 py-2">
          <button className="text-primary hover:underline" onClick={() => setSelectedPackage(null)}>{t('snippets.breadcrumb.allPackages')}</button>
          {breadcrumb.map((b) => (
            <span key={b.path} className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('snippets.breadcrumb.separator')}</span>
              <button className="text-primary hover:underline" onClick={() => setSelectedPackage(b.path)}>{b.name}</button>
            </span>
          ))}
        </div>

        {!snippets.length && displayedPackages.length === 0 && (
          <div className="flex-1 flex items-center justify-center px-4">
            <div className="flex flex-col items-center justify-center text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <FileCode size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{t('snippets.empty.title')}</h3>
              <p className="text-sm text-center max-w-sm">{t('snippets.empty.desc')}</p>
            </div>
          </div>
        )}

        <div
          ref={listRef}
          className="flex-1 space-y-3 overflow-y-auto px-4 pb-4"
          onDragOverCapture={handleReorderDragOver}
          onDropCapture={handleReorderDrop}
          onDragEndCapture={resetSnippetDragState}
        >
          {displayedPackages.length > 0 && !search.trim() && (
            <>
              <div className="flex items-center justify-between">
                <h3 className={vaultSectionTitleClass}>{t('snippets.section.packages')}</h3>
              </div>
              <div className={cn(
                viewMode === 'grid'
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-0"
              )}>
                {displayedPackages.map((pkg) => (
                  <ContextMenu key={pkg.path}>
                    <ContextMenuTrigger>
                      <div
                        className={cn(
                          "vault-drop-indicator-row group cursor-pointer overflow-hidden",
                          viewMode === 'grid'
                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                        )}
                        data-pkg-path={pkg.path}
                        data-vault-grid-item={`snippet-package:${pkg.path}`}
                        data-vault-reorder-grid={viewMode === 'grid' ? 'true' : undefined}
                        data-vault-reorder-dragging={draggingPackagePath === pkg.path ? 'true' : undefined}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('pkg-path', pkg.path);
                          draggingPackagePathRef.current = pkg.path;
                          setDraggingPackagePath(pkg.path);
                          lastPreviewReorderRef.current = null;
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const sId = draggingSnippetIdRef.current || e.dataTransfer.getData('snippet-id');
                          const pPath = draggingPackagePathRef.current || e.dataTransfer.getData('pkg-path');
                          if (sId) moveSnippet(sId, pkg.path);
                          if (
                            pPath &&
                            getPackageDropIntent(e.currentTarget, e.clientX, e.clientY, viewMode === 'grid') === 'inside'
                          ) {
                            movePackage(pPath, pkg.path);
                          }
                        }}
                        onClick={() => setSelectedPackage(pkg.path)}
                      >
                        <div className="flex items-center gap-3 h-full min-w-0">
                          <VaultEntityIcon
                            className={vaultPrimaryIconClass}
                            icon={<Package size={18} />}
                          />
                          <div className="w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{pkg.name}</div>
                            <div className="text-[11px] text-muted-foreground">{t('snippets.package.count', { count: pkg.count })}</div>
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setSelectedPackage(pkg.path)}>{t('action.open')}</ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => exportPackageSnippets(pkg.path)}
                        disabled={getSnippetsInPackage(pkg.path).length === 0}
                      >
                        <Download className="mr-2 h-4 w-4" /> {t('snippets.export.package')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => openRenameDialog(pkg.path)}>{t('common.rename')}</ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => deletePackage(pkg.path)}>{t('action.delete')}</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </>
          )}

          {displayedSnippets.length > 0 && (
            <div className="space-y-2">
              <h3 className={vaultSectionTitleClass}>{t('snippets.section.snippets')}</h3>
              <div className={cn(
                viewMode === 'grid'
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-0"
              )}>
                {displayedSnippets.map((snippet) => {
                  const isSelected = selectedSnippetIds.has(snippet.id);
                  return (
                  <ContextMenu key={snippet.id}>
                    <ContextMenuTrigger>
                      <div
                        className={cn(
                          "vault-drop-indicator-row group cursor-pointer overflow-hidden",
                          isSelected && (viewMode === 'grid' ? "ring-2 ring-primary/45 bg-primary/5" : "bg-primary/5"),
                          viewMode === 'grid'
                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors"
                        )}
                        data-snippet-id={isSearchActive ? undefined : snippet.id}
                        data-vault-grid-item={`snippet:${snippet.id}`}
                        data-vault-reorder-grid={viewMode === 'grid' ? 'true' : undefined}
                        data-vault-reorder-dragging={draggingSnippetId === snippet.id ? 'true' : undefined}
                        draggable={!isSearchActive && !isMultiSelectMode}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('snippet-id', snippet.id);
                          draggingSnippetIdRef.current = snippet.id;
                          setDraggingSnippetId(snippet.id);
                          lastPreviewReorderRef.current = null;
                        }}
                        onClick={() => {
                          if (isMultiSelectMode) {
                            toggleSnippetSelection(snippet.id);
                          } else {
                            handleEdit(snippet);
                          }
                        }}
                      >
                        <div className="flex items-center gap-3 h-full min-w-0">
                          {isMultiSelectMode && (
                            <div
                              className="shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSnippetSelection(snippet.id);
                              }}
                            >
                              {isSelected ? (
                                <CheckSquare size={18} className="text-primary" />
                              ) : (
                                <Square size={18} className="text-muted-foreground" />
                              )}
                            </div>
                          )}
                          <VaultEntityIcon
                            className={isScriptSnippet(snippet) ? vaultAutomationScriptIconClass : vaultSnippetIconClass}
                            icon={isScriptSnippet(snippet) ? (
                              <Play size={18} />
                            ) : (
                              <Zap size={18} />
                            )}
                          />
                          <div className="w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{snippet.label}</div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="text-[11px] text-muted-foreground font-mono leading-4 truncate">
                                  {snippet.command.replace(/\s+/g, ' ') || t('snippets.commandFallback')}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-sm break-all font-mono text-xs">
                                {snippet.command}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          {snippet.shortkey && (
                            <div className="shrink-0 px-2 py-1 text-[10px] font-mono rounded border border-border bg-muted/50 text-muted-foreground">
                              {snippet.shortkey}
                            </div>
                          )}
                          {viewMode === 'list' && !isMultiSelectMode && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                              onClick={(e) => { e.stopPropagation(); handleEdit(snippet); }}
                            >
                              <Edit2 size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => {
                          const runTargets = getRunnableHostsForSnippet(snippet, hosts);
                          if (runTargets.length > 0) {
                            onRunSnippet?.(snippet, runTargets);
                            return;
                          }
                          toast.error(t('scripts.actions.noRunnableHosts'));
                        }}
                        disabled={getRunnableHostsForSnippet(snippet, hosts).length === 0}
                      >
                        <Play className="mr-2 h-4 w-4" /> {t('action.run')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => handleEdit(snippet)}>
                        <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCopy(snippet.id, snippet.command)}>
                        <Copy className="mr-2 h-4 w-4" /> {t('action.copy')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => exportSingleSnippet(snippet)}>
                        <Download className="mr-2 h-4 w-4" /> {t('snippets.export.snippet')}
                      </ContextMenuItem>
                      <ContextMenuItem className="text-destructive" onClick={() => onDelete(snippet.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  );
                })}
              </div>
            </div>
          )}
          {search.trim() && displayedSnippets.length === 0 && (snippets.length > 0 || displayedPackages.length > 0) && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="h-14 w-14 rounded-2xl bg-secondary/80 flex items-center justify-center mb-3">
                <Search size={24} className="opacity-60" />
              </div>
              <h3 className="text-base font-semibold text-foreground mb-1">
                {t('snippets.search.noResults.title')}
              </h3>
              <p className="text-xs text-center max-w-sm">
                {t('snippets.search.noResults.desc', { query: search.trim() })}
              </p>
            </div>
          )}
        </div>
      </div>

      <SnippetsPackageDialogs
        isPackageDialogOpen={isPackageDialogOpen}
        t={t}
        selectedPackage={selectedPackage}
        newPackageName={newPackageName}
        setNewPackageName={setNewPackageName}
        createPackage={createPackage}
        setIsPackageDialogOpen={setIsPackageDialogOpen}
        isRenameDialogOpen={isRenameDialogOpen}
        renamingPackagePath={renamingPackagePath}
        renamePackageName={renamePackageName}
        setRenamePackageName={setRenamePackageName}
        setRenameError={setRenameError}
        renamePackage={renamePackage}
        renameError={renameError}
        setIsRenameDialogOpen={setIsRenameDialogOpen}
      />

      <SnippetImportDialog
        open={isSnippetImportDialogOpen}
        pendingImport={pendingImport}
        t={t}
        fileInputRef={snippetImportInputRef}
        onOpenChange={(open) => {
          setIsSnippetImportDialogOpen(open);
          if (!open) setPendingImport(null);
        }}
        onFileSelected={handleSnippetImportFileSelected}
        onChooseFile={() => snippetImportInputRef.current?.click()}
        onDownloadExamples={downloadSnippetImportExamples}
        onConfirmSkip={() => {
          if (pendingImport) applySnippetImport(pendingImport.payload, 'skip');
        }}
        onConfirmOverwrite={() => {
          if (pendingImport) applySnippetImport(pendingImport.payload, 'overwrite');
        }}
      />

      {renderRightPanel()}
    </div>
    </TooltipProvider>
  );
};

export default SnippetsManager;
