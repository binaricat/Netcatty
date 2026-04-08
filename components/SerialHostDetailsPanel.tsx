/**
 * Serial Host Details Panel
 * A dedicated editor for serial port hosts (distinct from SSH HostDetailsPanel)
 */
import { ChevronDown, ChevronUp, Save, Tag, Usb } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { Host, SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';

import { Button } from './ui/button';
import { Combobox, ComboboxOption, MultiCombobox } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
} from './ui/aside-panel';

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
  onSave: (host: Host) => void;
  onCancel: () => void;
  layout?: AsidePanelLayout;
}

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
const PARITY_OPTIONS: SerialParity[] = ['none', 'even', 'odd', 'mark', 'space'];
const FLOW_CONTROL_OPTIONS: SerialFlowControl[] = ['none', 'xon/xoff', 'rts/cts'];

export const SerialHostDetailsPanel: React.FC<SerialHostDetailsPanelProps> = ({
  initialData,
  allTags = [],
  groups = [],
  onSave,
  onCancel,
  layout = 'overlay',
}) => {
  const { t } = useI18n();
  const terminalBackend = useTerminalBackend();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form state
  const [label, setLabel] = useState(initialData.label);
  const [selectedPort, setSelectedPort] = useState(initialData.hostname || initialData.serialConfig?.path || '');
  const [baudRate, setBaudRate] = useState(initialData.serialConfig?.baudRate || initialData.port || 115200);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(initialData.serialConfig?.dataBits || 8);
  const [stopBits, setStopBits] = useState<1 | 1.5 | 2>(initialData.serialConfig?.stopBits || 1);
  const [parity, setParity] = useState<SerialParity>(initialData.serialConfig?.parity || 'none');
  const [flowControl, setFlowControl] = useState<SerialFlowControl>(initialData.serialConfig?.flowControl || 'none');
  const [localEcho, setLocalEcho] = useState(initialData.serialConfig?.localEcho || false);
  const [lineMode, setLineMode] = useState(initialData.serialConfig?.lineMode || false);
  const [charset, setCharset] = useState(initialData.charset || 'UTF-8');
  const [tags, setTags] = useState<string[]>(initialData.tags || []);
  const [group, setGroup] = useState(initialData.group || '');

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
    };

    const portName = selectedPort.split('/').pop() || selectedPort;
    const updatedHost: Host = {
      ...initialData,
      label: label.trim() || `Serial: ${portName}`,
      hostname: selectedPort,
      port: baudRate,
      tags,
      group,
      charset,
      serialConfig: config,
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
      className="z-40"
      layout={layout}
      dataSection="serial-host-details-panel"
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
                <select
                  id="data-bits"
                  value={dataBits}
                  onChange={(e) => setDataBits(parseInt(e.target.value, 10) as 5 | 6 | 7 | 8)}
                  className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {DATA_BITS.map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stop Bits */}
              <div className="space-y-2">
                <Label htmlFor="stop-bits">{t('serial.field.stopBits')}</Label>
                <select
                  id="stop-bits"
                  value={stopBits}
                  onChange={(e) => setStopBits(parseFloat(e.target.value) as 1 | 1.5 | 2)}
                  className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {STOP_BITS.map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </select>
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
              <select
                id="parity"
                value={parity}
                onChange={(e) => setParity(e.target.value as SerialParity)}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {PARITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(`serial.parity.${option}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* Flow Control */}
            <div className="space-y-2">
              <Label htmlFor="flow-control">{t('serial.field.flowControl')}</Label>
              <select
                id="flow-control"
                value={flowControl}
                onChange={(e) => setFlowControl(e.target.value as SerialFlowControl)}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {FLOW_CONTROL_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(`serial.flowControl.${option}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* Terminal Options */}
            <div className="space-y-3 pt-2 border-t border-border/60">
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
