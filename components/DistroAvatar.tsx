import { Server, Usb } from "lucide-react";
import React, { memo } from "react";
import { getEffectiveHostDistro } from "../domain/host";
import { cn } from "../lib/utils";
import { Host } from "../types";

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
  almalinux: "/distro/almalinux.svg",
  alinux: "/distro/alinux.svg",
  // OS-level logos (used by local terminal tab icons)
  macos: "/distro/macos.svg",
  windows: "/distro/windows.svg",
  linux: "/distro/linux.svg",
  // Network device vendors — auto-detected from the SSH server
  // identification string (see domain/host.ts `detectVendorFromSshVersion`).
  cisco: "/distro/cisco.svg",
  juniper: "/distro/juniper.svg",
  huawei: "/distro/huawei.svg",
  hpe: "/distro/hpe.svg",
  mikrotik: "/distro/mikrotik.svg",
  fortinet: "/distro/fortinet.svg",
  paloalto: "/distro/paloalto.svg",
  zyxel: "/distro/zyxel.svg",
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
  almalinux: "bg-[#173B66]",
  alinux: "bg-[#FF6A00]",
  // OS-level colors
  macos: "bg-[#333333]",
  windows: "bg-[#0078D4]",
  linux: "bg-[#333333]",
  // Network device vendor brand colors
  cisco: "bg-[#1BA0D7]",
  juniper: "bg-[#0A6EB4]",
  huawei: "bg-[#CF0A2C]",
  hpe: "bg-[#01A982]",
  mikrotik: "bg-[#293239]",
  fortinet: "bg-[#EE3124]",
  paloalto: "bg-[#FA582D]",
  zyxel: "bg-[#00497A]",
  ruijie: "bg-[#E60012]",
  default: "bg-slate-600",
};

type DistroAvatarProps = {
  host: Pick<Host, "distro" | "manualDistro" | "distroMode" | "os"> &
    Partial<Pick<Host, "protocol">>;
  fallback: string;
  className?: string;
  /** xs matches top tab bar icons (h-4 rounded rect) */
  size?: "xs" | "sm" | "md" | "tree" | "log" | "lg";
};

const DistroAvatarInner: React.FC<DistroAvatarProps> = ({
  host,
  fallback: _fallback,
  className,
  size = "md",
}) => {
  const distro = getEffectiveHostDistro(host);
  const logo = DISTRO_LOGOS[distro];
  const [errored, setErrored] = React.useState(false);
  const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;

  // Size variants — rounded rects (same corner style as SessionTabIcon in TopTabItems)
  const sizeClasses = {
    xs: "h-4 w-4 rounded",
    sm: "h-5 w-5 rounded",
    md: "h-8 w-8 rounded",
    tree: "h-8 w-8 rounded-lg",
    log: "h-9 w-9 rounded-xl",
    lg: "h-11 w-11 rounded-xl",
  };
  const iconSizes = {
    xs: "h-2.5 w-2.5",
    sm: "h-3 w-3",
    md: "h-4 w-4",
    tree: "h-4 w-4",
    log: "h-5 w-5",
    lg: "h-5 w-5",
  };

  const containerClass = sizeClasses[size];
  const iconSize = iconSizes[size];

  // Show USB icon for serial hosts
  if (host.protocol === 'serial') {
    return (
      <div
        className={cn(
          "shrink-0 rounded flex items-center justify-center bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950",
          containerClass,
          className,
        )}
      >
        <Usb className={iconSize} />
      </div>
    );
  }

  if (logo && !errored) {
    return (
      <div
        className={cn(
          "shrink-0 rounded flex items-center justify-center overflow-hidden",
          containerClass,
          bg,
          className,
        )}
      >
        <img
          src={logo}
          alt={distro || host.os}
          className={cn("object-contain invert brightness-0", iconSize)}
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "shrink-0 rounded flex items-center justify-center bg-primary text-primary-foreground",
        containerClass,
        className,
      )}
    >
      <Server className={iconSize} />
    </div>
  );
};

export const DistroAvatar = memo(DistroAvatarInner);
DistroAvatar.displayName = "DistroAvatar";
