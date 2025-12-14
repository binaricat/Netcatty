/**
 * SyncStatusButton - Cloud Sync Status Indicator for Top Bar
 * 
 * Shows current sync state with colored indicators:
 * - Green dot: All synced
 * - Blue dot + spin: Syncing in progress  
 * - Yellow dot: Connecting/needs attention
 * - Red dot: Error
 * - Gray dot: No providers connected
 * 
 * Clicking opens a popover with quick sync controls and status details.
 */

import React, { useState } from 'react';
import {
  CloudOff,
  Github,
  Loader2,
  Lock,
  RefreshCw,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { useCloudSync, useSecurityState } from '../application/state/useCloudSync';
import type { CloudProvider } from '../domain/sync';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';

// ============================================================================
// Provider Icons
// ============================================================================

const GoogleDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm1.73 0l6.55 11.5H23L16.45 3.5H9.44zM8 15l-3.43 6h13.72l3.43-6H8z" />
  </svg>
);

const OneDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.5 18.5c0 .55-.45 1-1 1h-5c-2.21 0-4-1.79-4-4 0-1.86 1.28-3.41 3-3.86v-.14c0-2.21 1.79-4 4-4 1.1 0 2.1.45 2.82 1.18A5.003 5.003 0 0 1 15 4c2.76 0 5 2.24 5 5 0 .16 0 .32-.02.47A4.5 4.5 0 0 1 24 13.5c0 2.49-2.01 4.5-4.5 4.5h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5H19c-.28 0-.5-.22-.5-.5 0-2.21-1.79-4-4-4-1.87 0-3.44 1.28-3.88 3.02-.09.37-.41.63-.79.63-1.66 0-3 1.34-3 3v.5c0 .28-.22.5-.5.5-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5h5c.55 0 1 .45 1 1z" />
  </svg>
);

const providerIcons: Record<CloudProvider, React.ReactNode> = {
  github: <Github size={14} />,
  google: <GoogleDriveIcon className="w-3.5 h-3.5" />,
  onedrive: <OneDriveIcon className="w-3.5 h-3.5" />,
};

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusIndicatorProps {
  status: 'synced' | 'syncing' | 'error' | 'locked' | 'setup' | 'none';
  size?: 'sm' | 'md';
  className?: string;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, size = 'sm', className }) => {
  const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  
  const baseClasses = cn(
    'rounded-full',
    sizeClass,
    status === 'syncing' && 'animate-pulse',
    className
  );
  
  const colors = {
    synced: 'bg-green-500',
    syncing: 'bg-blue-500',
    error: 'bg-red-500',
    locked: 'bg-amber-500',
    setup: 'bg-muted-foreground/50',
    none: 'bg-muted-foreground/30',
  };
  
  return <span className={cn(baseClasses, colors[status])} />;
};

// ============================================================================
// Provider Row Component
// ============================================================================

interface ProviderRowProps {
  provider: CloudProvider;
  name: string;
  isConnected: boolean;
  isSyncing: boolean;
  lastSync?: number;
  avatarUrl?: string;
  error?: string;
  onSync: () => void;
}

const ProviderRow: React.FC<ProviderRowProps> = ({
  provider,
  name,
  isConnected,
  isSyncing,
  lastSync,
  avatarUrl,
  error,
  onSync,
}) => {
  const formatTime = (timestamp?: number): string => {
    if (!timestamp) return 'Never';
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className={cn(
        "w-6 h-6 rounded flex items-center justify-center",
        isConnected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}>
        {providerIcons[provider]}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{name}</span>
          {isConnected && (
            <StatusIndicator 
              status={error ? 'error' : isSyncing ? 'syncing' : 'synced'} 
            />
          )}
        </div>
        {isConnected ? (
          <div className="flex items-center gap-1">
            {avatarUrl && (
              <img src={avatarUrl} alt="" className="w-3 h-3 rounded-full" />
            )}
            <span className="text-[10px] text-muted-foreground">
              {formatTime(lastSync)}
            </span>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">Not connected</span>
        )}
      </div>
      
      {isConnected && (
        <button
          onClick={onSync}
          disabled={isSyncing}
          className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
          title="Sync now"
        >
          {isSyncing ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : (
            <RefreshCw size={12} className="text-muted-foreground" />
          )}
        </button>
      )}
    </div>
  );
};

// ============================================================================
// Main SyncStatusButton Component
// ============================================================================

interface SyncStatusButtonProps {
  onOpenSettings?: () => void;
  className?: string;
}

export const SyncStatusButton: React.FC<SyncStatusButtonProps> = ({
  onOpenSettings,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const { isLocked, hasNoKey } = useSecurityState();
  const sync = useCloudSync();

  // Determine overall status for the button indicator
  const getOverallStatus = (): StatusIndicatorProps['status'] => {
    if (hasNoKey) return 'setup';
    if (isLocked) return 'locked';
    if (sync.isSyncing) return 'syncing';
    if (sync.lastError) return 'error';
    if (sync.hasAnyConnectedProvider) return 'synced';
    return 'none';
  };

  const overallStatus = getOverallStatus();

  // Get the button icon based on state
  const getButtonIcon = () => {
    if (hasNoKey) return <Shield size={16} />;
    if (isLocked) return <Lock size={16} />;
    if (sync.isSyncing) return <Loader2 size={16} className="animate-spin" />;
    if (sync.lastError) return <ShieldAlert size={16} />;
    if (sync.hasAnyConnectedProvider) return <ShieldCheck size={16} />;
    return <CloudOff size={16} />;
  };

  // Handle sync for a specific provider
  const handleSync = async (provider: CloudProvider) => {
    // This would need the payload from the app - for now just trigger sync state
    // In real implementation, this should call through to the app's sync handler
    console.log('Sync requested for:', provider);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8 relative text-muted-foreground hover:text-foreground app-no-drag",
            className
          )}
          title="Cloud Sync"
        >
          {getButtonIcon()}
          
          {/* Status indicator dot */}
          <StatusIndicator
            status={overallStatus}
            size="sm"
            className="absolute -top-0.5 -right-0.5 ring-2 ring-background"
          />
        </Button>
      </PopoverTrigger>
      
      <PopoverContent 
        className="w-72 p-0" 
        align="end"
        sideOffset={8}
      >
        {/* Header */}
        <div className="px-3 py-2.5 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {overallStatus === 'synced' && (
                <ShieldCheck size={16} className="text-green-500" />
              )}
              {overallStatus === 'syncing' && (
                <Loader2 size={16} className="text-blue-500 animate-spin" />
              )}
              {overallStatus === 'error' && (
                <ShieldAlert size={16} className="text-red-500" />
              )}
              {overallStatus === 'locked' && (
                <Lock size={16} className="text-amber-500" />
              )}
              {(overallStatus === 'setup' || overallStatus === 'none') && (
                <Shield size={16} className="text-muted-foreground" />
              )}
              
              <span className="text-sm font-medium">
                {overallStatus === 'synced' && 'Synced'}
                {overallStatus === 'syncing' && 'Syncing...'}
                {overallStatus === 'error' && 'Sync Error'}
                {overallStatus === 'locked' && 'Vault Locked'}
                {overallStatus === 'setup' && 'Setup Required'}
                {overallStatus === 'none' && 'Not Connected'}
              </span>
            </div>
            
            {onOpenSettings && (
              <button
                onClick={() => {
                  setIsOpen(false);
                  onOpenSettings();
                }}
                className="p-1 rounded hover:bg-muted transition-colors"
                title="Sync Settings"
              >
                <Settings size={14} className="text-muted-foreground" />
              </button>
            )}
          </div>
          
          {sync.deviceName && overallStatus !== 'setup' && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {sync.deviceName}
            </div>
          )}
        </div>

        {/* Content based on state */}
        <div className="p-3">
          {hasNoKey ? (
            // Setup required
            <div className="text-center py-2">
              <Shield size={32} className="mx-auto mb-2 text-muted-foreground" />
              <p className="text-xs text-muted-foreground mb-3">
                Set up encrypted sync to keep your data safe across devices.
              </p>
              <Button 
                size="sm" 
                className="w-full"
                onClick={() => {
                  setIsOpen(false);
                  onOpenSettings?.();
                }}
              >
                Set Up Encryption
              </Button>
            </div>
          ) : isLocked ? (
            // Locked state
            <div className="text-center py-2">
              <Lock size={32} className="mx-auto mb-2 text-amber-500" />
              <p className="text-xs text-muted-foreground mb-3">
                Unlock your vault to sync data.
              </p>
              <Button 
                size="sm" 
                variant="outline"
                className="w-full gap-1"
                onClick={() => {
                  setIsOpen(false);
                  onOpenSettings?.();
                }}
              >
                <Unlock size={14} />
                Unlock Vault
              </Button>
            </div>
          ) : (
            // Connected/syncing state - show providers
            <>
              <ProviderRow
                provider="github"
                name="GitHub Gist"
                isConnected={sync.providers.github.status === 'connected'}
                isSyncing={sync.providers.github.status === 'syncing'}
                lastSync={sync.providers.github.lastSync}
                avatarUrl={sync.providers.github.account?.avatarUrl}
                error={sync.providers.github.error}
                onSync={() => handleSync('github')}
              />
              
              <ProviderRow
                provider="google"
                name="Google Drive"
                isConnected={sync.providers.google.status === 'connected'}
                isSyncing={sync.providers.google.status === 'syncing'}
                lastSync={sync.providers.google.lastSync}
                avatarUrl={sync.providers.google.account?.avatarUrl}
                error={sync.providers.google.error}
                onSync={() => handleSync('google')}
              />
              
              <ProviderRow
                provider="onedrive"
                name="OneDrive"
                isConnected={sync.providers.onedrive.status === 'connected'}
                isSyncing={sync.providers.onedrive.status === 'syncing'}
                lastSync={sync.providers.onedrive.lastSync}
                avatarUrl={sync.providers.onedrive.account?.avatarUrl}
                error={sync.providers.onedrive.error}
                onSync={() => handleSync('onedrive')}
              />
              
              {/* Quick actions */}
              {sync.hasAnyConnectedProvider && (
                <div className="mt-3 pt-3 border-t border-border/60">
                  <Button 
                    size="sm" 
                    variant="outline" 
                    className="w-full gap-1"
                    disabled={sync.isSyncing}
                    onClick={() => {
                      // Trigger sync all - needs to be connected to app state
                      console.log('Sync all requested');
                    }}
                  >
                    {sync.isSyncing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Sync All Now
                  </Button>
                </div>
              )}
              
              {!sync.hasAnyConnectedProvider && (
                <div className="text-center py-2">
                  <p className="text-xs text-muted-foreground mb-3">
                    Connect a cloud provider to start syncing.
                  </p>
                  <Button 
                    size="sm" 
                    className="w-full"
                    onClick={() => {
                      setIsOpen(false);
                      onOpenSettings?.();
                    }}
                  >
                    Connect Provider
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SyncStatusButton;
