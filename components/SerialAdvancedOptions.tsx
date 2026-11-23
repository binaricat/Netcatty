/**
 * Shared serial port form constants and sections used by both
 * SerialConnectModal and SerialHostDetailsPanel.
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import React from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { SerialConfig, SerialFlowControl, SerialParity } from '../domain/models';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Combobox } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export interface SerialPortInfo {
  path: string;
  manufacturer: string;
  serialNumber: string;
  vendorId: string;
  productId: string;
  pnpId: string;
  type?: 'hardware' | 'pseudo' | 'custom';
}

export const SERIAL_BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];
const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
const PARITY_OPTIONS: SerialParity[] = ['none', 'even', 'odd', 'mark', 'space'];
const FLOW_CONTROL_OPTIONS: SerialFlowControl[] = ['none', 'xon/xoff', 'rts/cts'];

export interface SerialBaudRateFieldProps {
  baudRate: number;
  onChange: (baudRate: number) => void;
}

export const SerialBaudRateField: React.FC<SerialBaudRateFieldProps> = ({
  baudRate,
  onChange,
}) => {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <Label htmlFor="baud-rate">{t('serial.field.baudRate')}</Label>
      <Combobox
        options={SERIAL_BAUD_RATES.map((rate) => ({
          value: String(rate),
          label: String(rate),
        }))}
        value={String(baudRate)}
        onValueChange={(val) => {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed) && parsed > 0) {
            onChange(parsed);
          }
        }}
        placeholder={t('serial.field.baudRatePlaceholder')}
        emptyText={t('serial.field.baudRateEmpty')}
        allowCreate
        createText={t('common.use')}
      />
      {baudRate > 0 && !SERIAL_BAUD_RATES.includes(baudRate) && (
        <p className="text-xs text-muted-foreground">
          {t('serial.field.customBaudRate')}
        </p>
      )}
    </div>
  );
};

export interface SerialAdvancedOptionsSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isNamedPipe: boolean;
  dataBits: 5 | 6 | 7 | 8;
  onDataBitsChange: (value: 5 | 6 | 7 | 8) => void;
  stopBits: 1 | 1.5 | 2;
  onStopBitsChange: (value: 1 | 1.5 | 2) => void;
  parity: SerialParity;
  onParityChange: (value: SerialParity) => void;
  flowControl: SerialFlowControl;
  onFlowControlChange: (value: SerialFlowControl) => void;
  backspaceBehavior: SerialConfig['backspaceBehavior'];
  onBackspaceBehaviorChange: (value: 'default' | 'ctrl-h') => void;
  byteOrientedBackspace: boolean;
  onByteOrientedBackspaceChange: (value: boolean) => void;
  localEcho: boolean;
  onLocalEchoChange: (value: boolean) => void;
  lineMode: boolean;
  onLineModeChange: (value: boolean) => void;
  charset: string;
  onCharsetChange: (value: string) => void;
}

export const SerialAdvancedOptionsSection: React.FC<SerialAdvancedOptionsSectionProps> = ({
  open,
  onOpenChange,
  isNamedPipe,
  dataBits,
  onDataBitsChange,
  stopBits,
  onStopBitsChange,
  parity,
  onParityChange,
  flowControl,
  onFlowControlChange,
  backspaceBehavior,
  onBackspaceBehaviorChange,
  byteOrientedBackspace,
  onByteOrientedBackspaceChange,
  localEcho,
  onLocalEchoChange,
  lineMode,
  onLineModeChange,
  charset,
  onCharsetChange,
}) => {
  const { t } = useI18n();
  const isStopBits15 = stopBits === 1.5;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between h-9 px-0 hover:bg-transparent"
        >
          <span className="text-sm font-medium text-muted-foreground">
            {t('common.advanced')}
          </span>
          {open ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2">
        {/* Hardware-only serial framing is not used by named pipes. */}
        {!isNamedPipe && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="data-bits">{t('serial.field.dataBits')}</Label>
                <Select
                  value={String(dataBits)}
                  onValueChange={(v) => onDataBitsChange(parseInt(v, 10) as 5 | 6 | 7 | 8)}
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

              <div className="space-y-2">
                <Label htmlFor="stop-bits">{t('serial.field.stopBits')}</Label>
                <Select
                  value={String(stopBits)}
                  onValueChange={(v) => onStopBitsChange(parseFloat(v) as 1 | 1.5 | 2)}
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

            <div className="space-y-2">
              <Label htmlFor="parity">{t('serial.field.parity')}</Label>
              <Select
                value={parity}
                onValueChange={(v) => onParityChange(v as SerialParity)}
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

            <div className="space-y-2">
              <Label htmlFor="flow-control">{t('serial.field.flowControl')}</Label>
              <Select
                value={flowControl}
                onValueChange={(v) => onFlowControlChange(v as SerialFlowControl)}
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
          </>
        )}

        {/* Terminal Options */}
        <div className="space-y-3 pt-2 border-t border-border/60">
          <div className="space-y-2">
            <Label htmlFor="serial-backspace">{t('serial.field.backspaceBehavior')}</Label>
            <Select
              value={backspaceBehavior}
              onValueChange={(value) => onBackspaceBehaviorChange(value === 'ctrl-h' ? 'ctrl-h' : 'default')}
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
              onChange={(e) => onByteOrientedBackspaceChange(e.target.checked)}
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
              onChange={(e) => onLocalEchoChange(e.target.checked)}
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
              onChange={(e) => onLineModeChange(e.target.checked)}
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
              onChange={(e) => onCharsetChange(e.target.value)}
              className="h-9"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
