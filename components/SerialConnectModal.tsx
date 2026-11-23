/**
 * Serial Port Connect Modal
 * Allows users to configure and connect to a serial port
 */
import { Cpu, RefreshCw, Save, Usb } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { Host, SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';
import { prepareSerialConfigForSavedHost } from '../domain/serialBackspace';
import { isSerialEndpointPath, isWindowsNamedPipePath } from '../domain/serialEndpoint';
import { cn } from '../lib/utils';
import {
  SerialAdvancedOptionsSection,
  SerialBaudRateField,
  type SerialPortInfo,
} from './SerialAdvancedOptions';
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

interface SerialConnectModalProps {
  open: boolean;
  onClose: () => void;
  onConnect: (config: SerialConfig, options?: { charset?: string }) => void;
  onSaveHost?: (host: Host) => void;
}

export const SerialConnectModal: React.FC<SerialConnectModalProps> = ({
  open,
  onClose,
  onConnect,
  onSaveHost,
}) => {
  const { t } = useI18n();
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
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
  const [backspaceBehavior, setBackspaceBehavior] = useState<SerialConfig['backspaceBehavior']>('default');
  const [byteOrientedBackspace, setByteOrientedBackspace] = useState(false);
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
      path: selectedPort.trim(),
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      localEcho,
      lineMode,
      backspaceBehavior,
      byteOrientedBackspace,
    };

    // Save as host if checkbox is checked and onSaveHost is provided
    if (saveConfig && onSaveHost) {
      const portName = selectedPort.split('/').pop() || selectedPort;
      const host: Host = {
        id: `serial-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        label: configLabel.trim() || `Serial: ${portName}`,
        hostname: selectedPort.trim(),
        // For serial hosts, port field stores baud rate as a numeric identifier.
        // The full configuration is stored in serialConfig for actual connection.
        port: baudRate,
        username: '',
        os: 'linux',
        tags: ['serial'],
        protocol: 'serial',
        createdAt: Date.now(),
        charset,
        serialConfig: prepareSerialConfigForSavedHost(config),
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

  const trimmedPort = selectedPort.trim();
  const isNamedPipe = isWindowsNamedPipePath(trimmedPort);
  const isPortValid = isSerialEndpointPath(trimmedPort);
  // Allow custom baud rates as long as they are positive integers
  const isBaudRateValid = Number.isInteger(baudRate) && baudRate > 0;
  const isValid = isPortValid && (isNamedPipe || isBaudRateValid);

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
            onBackspaceBehaviorChange={setBackspaceBehavior}
            byteOrientedBackspace={byteOrientedBackspace}
            onByteOrientedBackspaceChange={setByteOrientedBackspace}
            localEcho={localEcho}
            onLocalEchoChange={setLocalEcho}
            lineMode={lineMode}
            onLineModeChange={setLineMode}
            charset={charset}
            onCharsetChange={setCharset}
          />

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
