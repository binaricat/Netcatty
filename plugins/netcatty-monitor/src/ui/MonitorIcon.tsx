import React from 'react';

export type MonitorIconName = 'hosts' | 'online' | 'warnings' | 'critical' | 'cpu' | 'memory';

export function MonitorIcon({ name, className = 'nm-kpi-icon' }: { name: MonitorIconName; className?: string }) {
  return (
    <img
      className={className}
      src={`asset:assets/ui/${name}.svg`}
      alt=""
      width={15}
      height={15}
      aria-hidden="true"
    />
  );
}
