/**
 * Serial Host Details Panel
 * A dedicated editor for serial port hosts (distinct from SSH HostDetailsPanel)
 */
import { ChevronDown, ChevronUp, Eye, EyeOff, Save, Tag, Usb, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { GroupConfig, Host, SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';
import {
  resolveSerialBackspaceFormValue,
  resolveSerialBackspaceOverrideOnSave,
} from '../domain/serialBackspace';

import { Button } from './ui/button';
import { Combobox, ComboboxOption, MultiCombobox } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from './ui/aside-panel';
import { HostNotesEditor } from './host/HostNotesEditor';
import { cn } from '../lib/utils';

interface SerialPort {
  path: string;
  manufacturer: string;
  serialNumber: string;
  vendorId: string;
  productId: string;
  pnpId: string;
  type?: 'hardware' | 'pseudo' | 'custom';
}

interface SerialHostDetailsPanelProps {
  initialData: Host;
  allTags?: string[];
  groups?: string[];
  groupDefaults?: Partial<GroupConfig>;
  onSave: (host: Host) => void;
  onCancel: () => void;
  layout?: AsidePanelLayout;
  className?: string;
}

type SerialHostDetailsPanelPropsWithResize = SerialHostDetailsPanelProps & AsidePanelResizeProps;

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
const PARITY_OPTIONS: SerialParity[] = ['none', 'even', 'odd', 'mark', 'space'];
const FLOW_CONTROL_OPTIONS: SerialFlowControl[] = ['none', 'xon/xoff', 'rts/cts'];

export const SerialHostDetailsPanel: React.FC<SerialHostDetailsPanelPropsWithResize> = ({
  initialData,
  allTags = [],
  groups = [],
  groupDefaults,
  onSave,
  onCancel,
  layout = 'overlay',
  className,
  resizable,
  persistWidthStorageKey,
  resizeAriaLabel,
}) => {
  const { t } = useI18n();
  const terminalBackend = useTerminalBackend();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Form state
  const [label, setLabel] = useState(initialData.label);
  const [username, setUsername] = useState(initialData.username || '');
  const [password, setPassword] = useState(initialData.password || '');
  // Tracks whether the user edited the password field this session. An empty
  // password is a meaningful serial credential (the auto-login detector
  // submits a blank line at a Password prompt), so an explicit edit to blank
  // must be saved as '' while an untouched field preserves the stored value.
  const [passwordChanged, setPasswordChanged] = useState(false);
  // Explicit "remove the saved credential" flag. An empty password field is a
  // meaningful serial credential (a present blank password), so blanking the
  // input alone cannot restore `password` to undefined — the user needs a
  // dedicated control to delete the credential entirely.
  const [passwordCleared, setPasswordCleared] = useState(false);
  const [selectedPort, setSelectedPort] = useState(initialData.hostname || initialData.serialConfig?.path || '');
  const [baudRate, setBaudRate] = useState(initialData.serialConfig?.baudRate || initialData.port || 115200);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(initialData.serialConfig?.dataBits || 8);
  const [stopBits, setStopBits] = useState<1 | 1.5 | 2>(initialData.serialConfig?.stopBits || 1);
  const [parity, setParity] = useState<SerialParity>(initialData.serialConfig?.parity || 'none');
  const [flowControl, setFlowControl] = useState<SerialFlowControl>(initialData.serialConfig?.flowControl || 'none');
  const [localEcho, setLocalEcho] = useState(initialData.serialConfig?.localEcho || false);
  const [lineMode, setLineMode] = useState(initialData.serialConfig?.lineMode || false);
  const [backspaceBehavior, setBackspaceBehavior] = useState(
    resolveSerialBackspaceFormValue(initialData, groupDefaults),
  );
  const [backspaceBehaviorChanged, setBackspaceBehaviorChanged] = useState(false);
  const [byteOrientedBackspace, setByteOrientedBackspace] = useState(
    initialData.serialConfig?.byteOrientedBackspace ?? false,
  );
  const [charset, setCharset] = useState(initialData.charset || 'UTF-8');
  const [tags, setTags] = useState<string[]>(initialData.tags || []);
  const [group, setGroup] = useState(initialData.group || '');
  const [notes, setNotes] = useState(initialData.notes ?? '');

  const loadPorts = useCallback(async () => {
    setIsLoadingPorts(true);
    try {
      const result = await terminalBackend.listSerialPorts();
      setPorts(result);
    } catch (err) {
      console.error('[Serial] Failed to list ports:', err);
    } finally {
      setIsLoadingPorts(false);
    }
  }, [terminalBackend]);

  useEffect(() => {
    loadPorts();
  }, [loadPorts]);

  const handleSave = () => {
    if (!selectedPort) return;

    const config: SerialConfig = {
      path: selectedPort,
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      localEcho,
      lineMode,
      backspaceBehavior: resolveSerialBackspaceOverrideOnSave({
        initialHost: initialData,
        selectedBehavior: backspaceBehavior,
        behaviorChanged: backspaceBehaviorChanged,
      }),
      byteOrientedBackspace,
    };

    const portName = selectedPort.split('/').pop() || selectedPort;
    const updatedHost: Host = {
      ...initialData,
      label: label.trim() || `Serial: ${portName}`,
      hostname: selectedPort,
      port: baudRate,
      username: username.trim() || undefined,
      // An empty password is meaningful for serial auto-login: the detector
      // distinguishes an absent password from a present empty string and
      // submits the required blank line at a Password prompt. An explicit edit
      // saves exactly what the user typed (including a blank line); the
      // dedicated clear control removes the credential entirely (undefined);
      // an untouched field preserves the stored credential as-is.
      password: passwordChanged
        ? (passwordCleared ? undefined : password)
        : (initialData.password ?? undefined),
      tags,
      group,
      charset,
      serialConfig: config,
      backspaceBehavior: undefined,
      notes: notes.trim() || undefined,
    };

    onSave(updatedHost);
  };

  // Convert ports to Combobox options
  const portOptions: ComboboxOption[] = useMemo(() => {
    return ports.map((port) => ({
      value: port.path,
      label: port.path,
      sublabel: port.manufacturer || undefined,
    }));
  }, [ports]);

  // Tag options for MultiCombobox
  const tagOptions: ComboboxOption[] = useMemo(() => {
    const allUniqueTags = new Set([...allTags, ...tags]);
    return Array.from(allUniqueTags).map((tag) => ({
      value: tag,
      label: tag,
    }));
  }, [allTags, tags]);

  // Group options for Combobox
  const groupOptions: ComboboxOption[] = useMemo(() => {
    const allGroups = new Set(groups);
    if (group && !allGroups.has(group)) {
      allGroups.add(group);
    }
    return Array.from(allGroups).map((g) => ({
      value: g,
      label: g,
    }));
  }, [groups, group]);

  // Validation
  const trimmedPort = selectedPort.trim();
  const isPortValid =
    trimmedPort.startsWith('/dev/') ||
    /^COM\d+$/i.test(trimmedPort) ||
    /^\\\\\.\\COM\d+$/i.test(trimmedPort);
  const isBaudRateValid = Number.isInteger(baudRate) && baudRate > 0;
  const isValid = isPortValid && isBaudRateValid;

  // Check if using 1.5 stop bits (limited Windows support)
  const isStopBits15 = stopBits === 1.5;

  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      title={t('serial.edit.title')}
      subtitle={initialData.label}
      className={cn('z-40', className)}
      layout={layout}
      dataSection="serial-host-details-panel"
      resizable={resizable}
      persistWidthStorageKey={persistWidthStorageKey}
      resizeAriaLabel={resizeAriaLabel}
    >
      <AsidePanelContent>
        {/* Label */}
        <div className="space-y-2">
          <Label htmlFor="serial-label">{t('serial.field.configLabel')}</Label>
          <Input
            id="serial-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('serial.field.configLabelPlaceholder')}
          />
        </div>

        {/* Serial Port */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="serial-port">{t('serial.field.port')}</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadPorts}
              disabled={isLoadingPorts}
              className="h-6 px-2 text-xs"
            >
              {t('common.refresh')}
            </Button>
          </div>
          <Combobox
            options={portOptions}
            value={selectedPort}
            onValueChange={setSelectedPort}
            placeholder={t('serial.field.selectPort')}
            emptyText={t('serial.noPorts')}
            allowCreate
            createText={t('common.use')}
            icon={<Usb size={14} className="text-muted-foreground" />}
          />
          {!isPortValid && selectedPort && (
            <p className="text-xs text-destructive">
              {t('serial.field.customPortPlaceholder')}
            </p>
          )}
        </div>

        {/* Baud Rate */}
        <div className="space-y-2">
          <Label htmlFor="baud-rate">{t('serial.field.baudRate')}</Label>
          <Combobox
            options={BAUD_RATES.map((rate) => ({
              value: String(rate),
              label: String(rate),
            }))}
            value={String(baudRate)}
            onValueChange={(val) => {
              const parsed = parseInt(val, 10);
              if (!isNaN(parsed) && parsed > 0) {
                setBaudRate(parsed);
              }
            }}
            placeholder={t('serial.field.baudRatePlaceholder')}
            emptyText={t('serial.field.baudRateEmpty')}
            allowCreate
            createText={t('common.use')}
          />
          {baudRate > 0 && !BAUD_RATES.includes(baudRate) && (
            <p className="text-xs text-muted-foreground">
              {t('serial.field.customBaudRate')}
            </p>
          )}
        </div>

        {/* Login credentials (auto-login) */}
        <div className="space-y-2">
          <Label htmlFor="serial-username">{t('serial.field.username')}</Label>
          <Input
            id="serial-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('serial.field.username')}
            autoComplete="off"
          />
          <div className="relative">
            <Input
              id="serial-password"
              value={password}
              type={showPassword ? 'text' : 'password'}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordChanged(true);
                if (e.target.value !== '') {
                  setPasswordCleared(false);
                }
              }}
              placeholder={t('serial.field.password')}
              autoComplete="off"
              className="pr-16"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              {(initialData.password !== undefined || password !== '') && (
                <button
                  type="button"
                  onClick={() => {
                    setPassword('');
                    setPasswordChanged(true);
                    setPasswordCleared(true);
                  }}
                  title={t('serial.field.clearPassword')}
                  aria-label={t('serial.field.clearPassword')}
                  className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('serial.field.autoLoginDesc')}
          </p>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Tag size={14} />
            {t('hostDetails.tags')}
          </Label>
          <MultiCombobox
            options={tagOptions}
            values={tags}
            onValuesChange={setTags}
            placeholder={t('hostDetails.addTag')}
            allowCreate
            createText={t('hostDetails.createTag')}
          />
        </div>

        <HostNotesEditor
          panelKey={initialData.id}
          value={notes}
          onChange={setNotes}
        />

        {/* Group */}
        <div className="space-y-2">
          <Label>{t('hostDetails.group')}</Label>
          <Combobox
            options={groupOptions}
            value={group}
            onValueChange={setGroup}
            placeholder={t('hostDetails.selectGroup')}
            allowCreate
            createText={t('hostDetails.createGroup')}
          />
        </div>

        {/* Advanced Options */}
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-between h-9 px-0 hover:bg-transparent"
            >
              <span className="text-sm font-medium text-muted-foreground">
                {t('common.advanced')}
              </span>
              {showAdvanced ? (
                <ChevronUp size={14} className="text-muted-foreground" />
              ) : (
                <ChevronDown size={14} className="text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
            {/* Data Bits */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="data-bits">{t('serial.field.dataBits')}</Label>
                <Select
                  value={String(dataBits)}
                  onValueChange={(v) => setDataBits(parseInt(v, 10) as 5 | 6 | 7 | 8)}
                >
                  <SelectTrigger id="data-bits">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATA_BITS.map((bits) => (
                      <SelectItem key={bits} value={String(bits)}>
                        {bits}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Stop Bits */}
              <div className="space-y-2">
                <Label htmlFor="stop-bits">{t('serial.field.stopBits')}</Label>
                <Select
                  value={String(stopBits)}
                  onValueChange={(v) => setStopBits(parseFloat(v) as 1 | 1.5 | 2)}
                >
                  <SelectTrigger id="stop-bits">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STOP_BITS.map((bits) => (
                      <SelectItem key={bits} value={String(bits)}>
                        {bits}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isStopBits15 && (
                  <p className="text-xs text-yellow-500">
                    {t('serial.field.stopBits15Warning')}
                  </p>
                )}
              </div>
            </div>

            {/* Parity */}
            <div className="space-y-2">
              <Label htmlFor="parity">{t('serial.field.parity')}</Label>
              <Select
                value={parity}
                onValueChange={(v) => setParity(v as SerialParity)}
              >
                <SelectTrigger id="parity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PARITY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`serial.parity.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Flow Control */}
            <div className="space-y-2">
              <Label htmlFor="flow-control">{t('serial.field.flowControl')}</Label>
              <Select
                value={flowControl}
                onValueChange={(v) => setFlowControl(v as SerialFlowControl)}
              >
                <SelectTrigger id="flow-control">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FLOW_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`serial.flowControl.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Terminal Options */}
            <div className="space-y-3 pt-2 border-t border-border/60">
              <div className="space-y-2">
                <Label htmlFor="serial-backspace">{t('serial.field.backspaceBehavior')}</Label>
                <Select
                  value={backspaceBehavior}
                  onValueChange={(value) => {
                    setBackspaceBehavior(value === 'ctrl-h' ? 'ctrl-h' : 'default');
                    setBackspaceBehaviorChanged(true);
                  }}
                >
                  <SelectTrigger id="serial-backspace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('serial.backspace.default')}</SelectItem>
                    <SelectItem value="ctrl-h">{t('serial.backspace.ctrlH')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('serial.field.backspaceBehaviorDesc')}
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="byte-oriented-backspace" className="text-sm font-medium cursor-pointer">
                    {t('serial.field.byteOrientedBackspace')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('serial.field.byteOrientedBackspaceDesc')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  id="byte-oriented-backspace"
                  checked={byteOrientedBackspace}
                  onChange={(e) => setByteOrientedBackspace(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="local-echo" className="text-sm font-medium cursor-pointer">
                    {t('serial.field.localEcho')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('serial.field.localEchoDesc')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  id="local-echo"
                  checked={localEcho}
                  onChange={(e) => setLocalEcho(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="line-mode" className="text-sm font-medium cursor-pointer">
                    {t('serial.field.lineMode')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('serial.field.lineModeDesc')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  id="line-mode"
                  checked={lineMode}
                  onChange={(e) => setLineMode(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>

              {/* Charset */}
              <div className="space-y-1">
                <Label htmlFor="serial-charset" className="text-sm font-medium">
                  {t('serial.field.charset')}
                </Label>
                <Input
                  id="serial-charset"
                  placeholder={t("hostDetails.charset.placeholder")}
                  value={charset}
                  onChange={(e) => setCharset(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </AsidePanelContent>

      <AsidePanelFooter>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!isValid} className="flex-1">
            <Save size={14} className="mr-2" />
            {t('common.save')}
          </Button>
        </div>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default SerialHostDetailsPanel;
