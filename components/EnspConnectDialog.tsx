/**
 * eNSP Pro Console Connect Dialog
 *
 * eNSP Pro devices expose no TCP console port: the platform relays the device
 * CLI over a WebSocket. Users therefore pick "platform + sandbox + device"
 * instead of a hostname, and the bridge opens the relay for them.
 */
import { Loader2, Network, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import type { EnspConfig } from '../domain/models';
import { Button } from './ui/button';
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

interface EnspConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (config: EnspConfig) => void;
  /** Platform address remembered from the previous connection. */
  initialHost?: string;
  initialPort?: number;
}

const DEFAULT_PORT = 8443;

/** Split "https://host:port" into the host the bridge expects plus its port. */
const splitAddress = (raw: string): { host: string; port: number | undefined } => {
  const value = raw.trim();
  if (!value) return { host: '', port: undefined };
  const withoutScheme = value.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const match = /^(.*?):(\d+)$/.exec(withoutScheme);
  if (match) {
    return { host: match[1], port: Number.parseInt(match[2], 10) };
  }
  return { host: withoutScheme, port: undefined };
};

export const EnspConnectDialog: React.FC<EnspConnectDialogProps> = ({
  open,
  onClose,
  onConnect,
  initialHost,
  initialPort,
}) => {
  const { t } = useI18n();
  const terminalBackend = useTerminalBackend();

  const [address, setAddress] = useState(initialHost || '');
  const [port, setPort] = useState(initialPort || DEFAULT_PORT);
  const [sandboxId, setSandboxId] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [password, setPassword] = useState('');
  const [sandboxes, setSandboxes] = useState<Array<{ id: number; name: string; deviceCount: number }>>([]);
  const [devices, setDevices] = useState<Array<{
    sandboxId: number;
    sandboxName: string;
    nodeId: number;
    name: string;
    deviceType?: string;
    status?: number;
  }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSandboxId('');
    setNodeId('');
    setPassword('');
    setSandboxes([]);
    setDevices([]);
    if (initialHost) setAddress(initialHost);
    if (initialPort) setPort(initialPort);
  }, [open, initialHost, initialPort]);

  const sandboxDevices = useMemo(
    () => devices.filter((device) => String(device.sandboxId) === sandboxId),
    [devices, sandboxId],
  );

  const loadDevices = useCallback(async () => {
    const parsed = splitAddress(address);
    if (!parsed.host) {
      setError(t('ensp.loadFailed'));
      return;
    }
    const effectivePort = parsed.port ?? port;
    setIsLoading(true);
    setError(null);
    try {
      const result = await terminalBackend.listEnspDevices({ host: parsed.host, port: effectivePort });
      if (parsed.port) setPort(parsed.port);
      setSandboxes(result.sandboxes ?? []);
      setDevices(result.devices ?? []);
      const firstSandbox = result.sandboxes?.[0];
      if (firstSandbox) {
        setSandboxId(String(firstSandbox.id));
        const firstDevice = (result.devices ?? []).find((device) => device.sandboxId === firstSandbox.id);
        setNodeId(firstDevice ? String(firstDevice.nodeId) : '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSandboxes([]);
      setDevices([]);
    } finally {
      setIsLoading(false);
    }
  }, [address, port, t, terminalBackend]);

  const handleSandboxChange = (value: string) => {
    setSandboxId(value);
    const firstDevice = devices.find((device) => String(device.sandboxId) === value);
    setNodeId(firstDevice ? String(firstDevice.nodeId) : '');
  };

  const handleConnect = () => {
    const parsed = splitAddress(address);
    const selectedSandbox = sandboxes.find((entry) => String(entry.id) === sandboxId);
    const selectedDevice = devices.find(
      (device) => String(device.sandboxId) === sandboxId && String(device.nodeId) === nodeId,
    );
    if (!parsed.host || !selectedSandbox || !selectedDevice) {
      setError(t('ensp.loadFailed'));
      return;
    }
    onConnect({
      host: parsed.host,
      port: parsed.port ?? port,
      sandboxId: selectedSandbox.id,
      nodeId: selectedDevice.nodeId,
      sandboxName: selectedSandbox.name,
      deviceName: selectedDevice.name,
      password: password || undefined,
    });
    onClose();
  };

  const canConnect = Boolean(sandboxId) && Boolean(nodeId) && address.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network size={16} /> {t('ensp.modal.title')}
          </DialogTitle>
          <DialogDescription>{t('ensp.modal.desc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ensp-host">{t('ensp.field.platform')}</Label>
              <Input
                id="ensp-host"
                value={address}
                placeholder="https://192.168.31.211"
                onChange={(event) => setAddress(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ensp-port">{t('ensp.field.port')}</Label>
              <Input
                id="ensp-port"
                inputMode="numeric"
                value={String(port)}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setPort(Number.isFinite(next) ? next : DEFAULT_PORT);
                }}
              />
            </div>
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isLoading || !address.trim()}
            onClick={() => void loadDevices()}
          >
            {isLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
            {isLoading ? t('ensp.fetching') : t('ensp.fetch')}
          </Button>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('ensp.field.sandbox')}</Label>
              <Select value={sandboxId} onValueChange={handleSandboxChange} disabled={sandboxes.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={t('ensp.selectSandbox')} />
                </SelectTrigger>
                <SelectContent>
                  {sandboxes.map((sandbox) => (
                    <SelectItem key={sandbox.id} value={String(sandbox.id)}>
                      {sandbox.name || String(sandbox.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('ensp.field.device')}</Label>
              <Select value={nodeId} onValueChange={setNodeId} disabled={sandboxDevices.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={t('ensp.selectDevice')} />
                </SelectTrigger>
                <SelectContent>
                  {sandboxDevices.map((device) => (
                    <SelectItem key={`${device.sandboxId}/${device.nodeId}`} value={String(device.nodeId)}>
                      {device.name || String(device.nodeId)}
                      {device.deviceType ? ` · ${device.deviceType}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ensp-password">{t('ensp.field.password')}</Label>
            <Input
              id="ensp-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('ensp.field.passwordHint')}</p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!canConnect} onClick={handleConnect}>{t('ensp.connect')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EnspConnectDialog;
