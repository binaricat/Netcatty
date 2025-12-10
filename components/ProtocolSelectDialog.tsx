import React, { useState, useMemo } from 'react';
import {
  Terminal as TerminalIcon,
  Globe,
  Wifi,
  X,
} from 'lucide-react';
import { Host, HostProtocol } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';

interface ProtocolOption {
  protocol: HostProtocol;
  port: number;
  label: string;
  icon: React.ReactNode;
  description: string;
  enabled: boolean;
}

interface ProtocolSelectDialogProps {
  host: Host;
  onSelect: (protocol: HostProtocol, port: number) => void;
  onCancel: () => void;
}

const ProtocolSelectDialog: React.FC<ProtocolSelectDialogProps> = ({
  host,
  onSelect,
  onCancel,
}) => {
  // Build protocol options from host configuration
  const protocolOptions = useMemo<ProtocolOption[]>(() => {
    const options: ProtocolOption[] = [];

    // SSH (always available if not explicitly disabled)
    const sshEnabled = host.protocol === 'ssh' || !host.protocol || host.protocols?.some(p => p.protocol === 'ssh' && p.enabled);
    if (sshEnabled !== false) {
      const sshConfig = host.protocols?.find(p => p.protocol === 'ssh');
      options.push({
        protocol: 'ssh',
        port: sshConfig?.port || host.port || 22,
        label: 'SSH',
        icon: <TerminalIcon size={18} />,
        description: `ssh ${host.hostname}`,
        enabled: true,
      });
    }

    // Mosh (if enabled)
    if (host.moshEnabled || host.protocols?.some(p => p.protocol === 'mosh' && p.enabled)) {
      const moshConfig = host.protocols?.find(p => p.protocol === 'mosh');
      options.push({
        protocol: 'mosh',
        port: moshConfig?.port || host.port || 22,
        label: 'Mosh',
        icon: <Wifi size={18} />,
        description: `mosh ${host.hostname}`,
        enabled: true,
      });
    }

    // Telnet (if enabled)
    if (host.telnetEnabled || host.protocol === 'telnet' || host.protocols?.some(p => p.protocol === 'telnet' && p.enabled)) {
      const telnetConfig = host.protocols?.find(p => p.protocol === 'telnet');
      options.push({
        protocol: 'telnet',
        port: telnetConfig?.port || host.telnetPort || 23,
        label: 'Telnet',
        icon: <Globe size={18} />,
        description: `telnet ${host.hostname}`,
        enabled: true,
      });
    }

    return options;
  }, [host]);

  // State for custom ports (allow editing inline)
  const [ports, setPorts] = useState<Record<HostProtocol, number>>(() => {
    const initial: Record<string, number> = {};
    protocolOptions.forEach(opt => {
      initial[opt.protocol] = opt.port;
    });
    return initial as Record<HostProtocol, number>;
  });

  const [selectedProtocol, setSelectedProtocol] = useState<HostProtocol>(
    protocolOptions[0]?.protocol || 'ssh'
  );

  const handlePortChange = (protocol: HostProtocol, value: string) => {
    const port = parseInt(value, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      setPorts(prev => ({ ...prev, [protocol]: port }));
    }
  };

  const handleContinue = () => {
    onSelect(selectedProtocol, ports[selectedProtocol] || 22);
  };

  // If only one protocol, auto-select and proceed
  React.useEffect(() => {
    if (protocolOptions.length === 1) {
      // Don't auto-proceed, let user confirm
    }
  }, [protocolOptions]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[560px] max-w-[90vw] bg-background border border-border/60 rounded-2xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center gap-3">
            <DistroAvatar 
              host={host} 
              fallback={host.label.slice(0, 2).toUpperCase()} 
              className="h-12 w-12" 
            />
            <div>
              <h2 className="text-base font-semibold">{host.label}</h2>
              <p className="text-xs text-muted-foreground font-mono">
                {host.hostname}
              </p>
            </div>
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-primary/20 text-primary flex items-center justify-center">
              <TerminalIcon size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
            <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
              {'>_'}
            </div>
          </div>
        </div>

        {/* Protocol selection */}
        <div className="px-6 py-4 space-y-4">
          <h3 className="text-base font-semibold">Choose protocol</h3>
          <div className="space-y-3">
            {protocolOptions.map((option) => (
              <button
                key={option.protocol}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
                  selectedProtocol === option.protocol
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:border-border hover:bg-secondary/50"
                )}
                onClick={() => setSelectedProtocol(option.protocol)}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-10 w-10 rounded-lg flex items-center justify-center",
                    selectedProtocol === option.protocol 
                      ? "bg-primary/20 text-primary" 
                      : "bg-muted text-muted-foreground"
                  )}>
                    {option.icon}
                  </div>
                  <div>
                    <div className="font-medium">{option.label}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {option.description}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">port:</span>
                  <Input
                    type="number"
                    value={ports[option.protocol] || option.port}
                    onChange={(e) => handlePortChange(option.protocol, e.target.value)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedProtocol(option.protocol);
                    }}
                    className="w-16 h-7 text-xs text-center"
                    min={1}
                    max={65535}
                  />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
          <Button onClick={handleContinue}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ProtocolSelectDialog;
