import React from 'react';
import { Host } from '../types';
import { normalizeDistroId } from '../domain/host';
import { cn } from '../lib/utils';

export const DISTRO_LOGOS: Record<string, string> = {
  ubuntu: "/distro/ubuntu.svg",
  debian: "/distro/debian.svg",
  centos: "/distro/centos.svg",
  rocky: "/distro/rocky.svg",
  fedora: "/distro/fedora.svg",
  arch: "/distro/arch.svg",
  alpine: "/distro/alpine.svg",
  amazon: "/distro/amazon.svg",
  opensuse: "/distro/opensuse.svg",
  redhat: "/distro/redhat.svg",
  oracle: "/distro/oracle.svg",
  kali: "/distro/kali.svg",
};

export const DISTRO_COLORS: Record<string, string> = {
  ubuntu: "bg-[#E95420]",
  debian: "bg-[#A81D33]",
  centos: "bg-[#9C27B0]",
  rocky: "bg-[#0B9B69]",
  fedora: "bg-[#3C6EB4]",
  arch: "bg-[#1793D1]",
  alpine: "bg-[#0D597F]",
  amazon: "bg-[#FF9900]",
  opensuse: "bg-[#73BA25]",
  redhat: "bg-[#EE0000]",
  oracle: "bg-[#C74634]",
  kali: "bg-[#0F6DB3]",
  default: "bg-slate-600",
};

type DistroAvatarProps = { host: Host; fallback: string; className?: string };

export const DistroAvatar: React.FC<DistroAvatarProps> = ({ host, fallback, className }) => {
  const distro = normalizeDistroId(host.distro) || (host.distro || '').toLowerCase();
  const logo = DISTRO_LOGOS[distro];
  const [errored, setErrored] = React.useState(false);
  const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;

  if (logo && !errored) {
    return (
      <div className={cn("h-12 w-12 rounded-lg flex items-center justify-center border border-border/40 overflow-hidden", bg, className)}>
        <img
          src={logo}
          alt={host.distro || host.os}
          className="h-7 w-7 object-contain invert brightness-0"
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center bg-slate-600/20", className)}>
      <span className="text-xs font-semibold">{fallback}</span>
    </div>
  );
};
