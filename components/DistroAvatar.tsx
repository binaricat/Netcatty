import { Server } from "lucide-react";
import React, { memo } from "react";
import { normalizeDistroId } from "../domain/host";
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

type DistroAvatarProps = {
  host: Host;
  fallback: string;
  className?: string;
  size?: "sm" | "md" | "lg";
};

const DistroAvatarInner: React.FC<DistroAvatarProps> = ({
  host,
  fallback: _fallback,
  className,
  size = "md",
}) => {
  const distro =
    normalizeDistroId(host.distro) || (host.distro || "").toLowerCase();
  const logo = DISTRO_LOGOS[distro];
  const [errored, setErrored] = React.useState(false);
  const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;

  // Size variants - all use rounded corners for consistency
  const sizeClasses = {
    sm: "h-6 w-6 rounded-md",
    md: "h-11 w-11 rounded-xl",
    lg: "h-14 w-14 rounded-xl",
  };
  const iconSizes = {
    sm: "h-3.5 w-3.5",
    md: "h-5 w-5",
    lg: "h-6 w-6",
  };

  const containerClass = sizeClasses[size];
  const iconSize = iconSizes[size];

  if (logo && !errored) {
    return (
      <div
        className={cn(
          containerClass,
          "flex items-center justify-center border border-border/40 overflow-hidden",
          bg,
          className,
        )}
      >
        <img
          src={logo}
          alt={host.distro || host.os}
          className={cn("object-contain invert brightness-0", iconSize)}
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        containerClass,
        "flex items-center justify-center bg-primary/15 text-primary",
        className,
      )}
    >
      <Server className={iconSize} />
    </div>
  );
};

export const DistroAvatar = memo(DistroAvatarInner);
DistroAvatar.displayName = "DistroAvatar";
