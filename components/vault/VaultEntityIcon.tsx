import React from "react";
import { cn } from "../../lib/utils";

type VaultEntityIconProps = {
  icon: React.ReactNode;
  className?: string;
  title?: string;
};

export const vaultEntityIconClass =
  "h-11 w-11 rounded-xl flex items-center justify-center shrink-0";

export const vaultPrimaryIconClass = "bg-primary text-primary-foreground";
export const vaultSnippetIconClass = "bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950";
export const vaultKeyIconClass = "bg-cyan-600 text-white dark:bg-cyan-400 dark:text-slate-950";
export const vaultCertificateIconClass = "bg-teal-600 text-white dark:bg-teal-400 dark:text-slate-950";
export const vaultIdentityIconClass = "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950";
export const vaultProxyHttpIconClass = "bg-teal-600 text-white dark:bg-teal-400 dark:text-slate-950";
export const vaultProxySocksIconClass = "bg-sky-600 text-white dark:bg-sky-400 dark:text-slate-950";
export const vaultProxyCommandIconClass = "bg-violet-600 text-white dark:bg-violet-400 dark:text-slate-950";

export const VaultEntityIcon: React.FC<VaultEntityIconProps> = ({
  icon,
  className,
  title,
}) => (
  <div
    className={cn(vaultEntityIconClass, className)}
    title={title}
  >
    {icon}
  </div>
);
