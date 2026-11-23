/**
 * Serial Host Details Panel
 * A dedicated editor for serial port hosts (distinct from SSH HostDetailsPanel)
 */
import { Eye, EyeOff, Save, Tag, Usb, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { GroupConfig, Host, SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';
import {
  resolveSerialBackspaceFormValue,
  resolveSerialBackspaceOverrideOnSave,
} from '../domain/serialBackspace';

import { isSerialEndpointPath, isWindowsNamedPipePath } from '../domain/serialEndpoint';

import {
  SerialAdvancedOptionsSection,
  SerialBaudRateField,
  type SerialPortInfo,
} from './SerialAdvancedOptions';
import { Button } from './ui/button';
import { Combobox, ComboboxOption, MultiCombobox } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from './ui/aside-panel';
import { HostNotesEditor } from './host/HostNotesEditor';
import { cn } from '../lib/utils';

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
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
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
  const [selectedPort, setSelectedPort] = useState(initialData.serialConfig?.path || initialData.hostname || '');
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
      path: selectedPort.trim(),
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
      hostname: selectedPort.trim(),
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
  const isNamedPipe = isWindowsNamedPipePath(trimmedPort);
  const isPortValid = isSerialEndpointPath(trimmedPort);
  const isBaudRateValid = Number.isInteger(baudRate) && baudRate > 0;
  const isValid = isPortValid && (isNamedPipe || isBaudRateValid);

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
          <p className="text-xs text-muted-foreground">
            {t('serial.field.namedPipeHint')}
          </p>
          {!isPortValid && selectedPort && (
            <p className="text-xs text-destructive">
              {t('serial.field.customPortPlaceholder')}
            </p>
          )}
        </div>

        {/* Baud Rate (not used by named pipes) */}
        {!isNamedPipe && (
          <SerialBaudRateField baudRate={baudRate} onChange={setBaudRate} />
        )}

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
        <SerialAdvancedOptionsSection
          open={showAdvanced}
          onOpenChange={setShowAdvanced}
          isNamedPipe={isNamedPipe}
          dataBits={dataBits}
          onDataBitsChange={setDataBits}
          stopBits={stopBits}
          onStopBitsChange={setStopBits}
          parity={parity}
          onParityChange={setParity}
          flowControl={flowControl}
          onFlowControlChange={setFlowControl}
          backspaceBehavior={backspaceBehavior}
          onBackspaceBehaviorChange={(value) => {
            setBackspaceBehavior(value);
            setBackspaceBehaviorChanged(true);
          }}
          byteOrientedBackspace={byteOrientedBackspace}
          onByteOrientedBackspaceChange={setByteOrientedBackspace}
          localEcho={localEcho}
          onLocalEchoChange={setLocalEcho}
          lineMode={lineMode}
          onLineModeChange={setLineMode}
          charset={charset}
          onCharsetChange={setCharset}
        />
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
