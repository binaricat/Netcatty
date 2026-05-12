/**
 * Serial Port Connect Modal
 * Allows users to configure and connect to a serial port
 */
import { ChevronDown, ChevronUp, Cpu, RefreshCw, Save, Usb } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { Host, SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Combobox, type ComboboxOption } from './ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

interface SerialPort {
  path: string;
  manufacturer: string;
  serialNumber: string;
  vendorId: string;
  productId: string;
  pnpId: string;
  type?: 'hardware' | 'pseudo' | 'custom';
}

interface SerialConnectModalProps {
  open: boolean;
  onClose: () => void;
  onConnect: (config: SerialConfig, options?: { charset?: string }) => void;
  onSaveHost?: (host: Host) => void;
}

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
const PARITY_OPTIONS: SerialParity[] = ['none', 'even', 'odd', 'mark', 'space'];
const FLOW_CONTROL_OPTIONS: SerialFlowControl[] = ['none', 'xon/xoff', 'rts/cts'];

export const SerialConnectModal: React.FC<SerialConnectModalProps> = ({
  open,
  onClose,
  onConnect,
  onSaveHost,
}) => {
  const { t } = useI18n();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form state
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(8);
  const [stopBits, setStopBits] = useState<1 | 1.5 | 2>(1);
  const [parity, setParity] = useState<SerialParity>('none');
  const [flowControl, setFlowControl] = useState<SerialFlowControl>('none');
  const [localEcho, setLocalEcho] = useState(false);
  const [lineMode, setLineMode] = useState(false);
  const [charset, setCharset] = useState('UTF-8');

  // Save configuration state
  const [saveConfig, setSaveConfig] = useState(false);
  const [configLabel, setConfigLabel] = useState('');

  const terminalBackend = useTerminalBackend();

  const loadPorts = useCallback(async () => {
    setIsLoadingPorts(true);
    try {
      const result = await terminalBackend.listSerialPorts();
      setPorts(result);
      // Auto-select first port if available and no port is selected
      if (result.length > 0) {
        setSelectedPort((prev) => prev || result[0].path);
      }
    } catch (err) {
      console.error('[Serial] Failed to list ports:', err);
    } finally {
      setIsLoadingPorts(false);
    }
  }, [terminalBackend]);

  useEffect(() => {
    if (open) {
      loadPorts();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Generate a default label when port is selected
  useEffect(() => {
    if (selectedPort && !configLabel) {
      const portName = selectedPort.split('/').pop() || selectedPort;
      setConfigLabel(`Serial: ${portName}`);
    }
  }, [selectedPort, configLabel]);

  const handleConnect = () => {
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

    // Save as host if checkbox is checked and onSaveHost is provided
    if (saveConfig && onSaveHost) {
      const portName = selectedPort.split('/').pop() || selectedPort;
      const host: Host = {
        id: `serial-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        label: configLabel.trim() || `Serial: ${portName}`,
        hostname: selectedPort,
        // For serial hosts, port field stores baud rate as a numeric identifier.
        // The full configuration is stored in serialConfig for actual connection.
        port: baudRate,
        username: '',
        os: 'linux',
        tags: ['serial'],
        protocol: 'serial',
        createdAt: Date.now(),
        charset,
        serialConfig: config, // Store full serial configuration for connection
      };
      onSaveHost(host);
    }

    onConnect(config, { charset });
    onClose();
  };

  // Convert ports to Combobox options
  const portOptions: ComboboxOption[] = useMemo(() => {
    return ports.map((port) => ({
      value: port.path,
      label: port.path,
      sublabel: port.manufacturer || undefined,
    }));
  }, [ports]);

  // Validate: port path must start with /dev/ (Unix/macOS) or COM/\\.\COM (Windows)
  const trimmedPort = selectedPort.trim();
  const isPortValid =
    trimmedPort.startsWith('/dev/') ||
    /^COM\d+$/i.test(trimmedPort) ||
    /^\\\\\.\\COM\d+$/i.test(trimmedPort);
  // Allow custom baud rates as long as they are positive integers
  const isBaudRateValid = Number.isInteger(baudRate) && baudRate > 0;

  // Check if using 1.5 stop bits (limited Windows support)
  const isStopBits15 = stopBits === 1.5;
  const isValid = isPortValid && isBaudRateValid;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Usb size={18} />
            {t('serial.modal.title')}
          </DialogTitle>
          <DialogDescription>
            {t('serial.modal.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
          {/* Serial Port Selection */}
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
                <RefreshCw size={12} className={cn("mr-1", isLoadingPorts && "animate-spin")} />
                {t('common.refresh')}
              </Button>
            </div>

            {/* Combobox for port selection with manual input support */}
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

          {/* Save Configuration */}
          {onSaveHost && (
            <div className="space-y-3 pt-2 border-t border-border/60">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="save-config" className="text-sm font-medium cursor-pointer">
                    {t('serial.field.saveConfig')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('serial.field.saveConfigDesc')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  id="save-config"
                  checked={saveConfig}
                  onChange={(e) => setSaveConfig(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>
              {saveConfig && (
                <div className="space-y-2">
                  <Label htmlFor="config-label">{t('serial.field.configLabel')}</Label>
                  <Input
                    id="config-label"
                    value={configLabel}
                    onChange={(e) => setConfigLabel(e.target.value)}
                    placeholder={t('serial.field.configLabelPlaceholder')}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConnect} disabled={!isValid}>
            {saveConfig ? (
              <Save size={14} className="mr-2" />
            ) : (
              <Cpu size={14} className="mr-2" />
            )}
            {saveConfig ? t('serial.connectAndSave') : t('common.connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SerialConnectModal;
