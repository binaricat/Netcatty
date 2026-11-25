import React, { memo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { AcceleratorVendor } from '../../domain/systemManager/types';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** Simple Icons NVIDIA path (CC0-1.0) — monochrome, uses currentColor. */
const NVIDIA_PATH =
  'M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z';

/** Huawei petal mark for Ascend NPU (decorative; text label carries the name). */
const HUAWEI_PATH =
  'M3.67 6.14S1.82 7.91 1.72 9.78v.35c.08 1.51 1.22 2.4 1.22 2.4 1.83 1.79 6.26 4.04 7.3 4.55 0 0 .06.03.1-.01l.02-.04v-.04C7.52 10.8 3.67 6.14 3.67 6.14zM9.65 18.6c-.02-.08-.1-.08-.1-.08l-7.38.26c.8 1.43 2.15 2.53 3.56 2.2.96-.25 3.16-1.78 3.88-2.3.06-.05.04-.09.04-.09zm.08-.78C6.49 15.63.21 12.28.21 12.28c-.15.46-.2.9-.21 1.3v.07c0 1.07.4 1.82.4 1.82.8 1.69 2.34 2.2 2.34 2.2.7.3 1.4.31 1.4.31.12.02 4.4 0 5.54 0 .05 0 .08-.05.08-.05v-.06c0-.03-.03-.05-.03-.05zM9.06 3.19a3.42 3.42 0 00-2.57 3.15v.41c.03.6.16 1.05.16 1.05.66 2.9 3.86 7.65 4.55 8.65.05.05.1.03.1.03a.1.1 0 00.06-.1c1.06-10.6-1.11-13.42-1.11-13.42-.32.02-1.19.23-1.19.23zm8.299 2.27s-.49-1.8-2.44-2.28c0 0-.57-.14-1.17-.22 0 0-2.18 2.81-1.12 13.43.01.07.06.08.06.08.07.03.1-.03.1-.03.72-1.03 3.9-5.76 4.55-8.64 0 0 .36-1.4.02-2.34zm-2.92 13.07s-.07 0-.09.05c0 0-.01.07.03.1.7.51 2.85 2 3.88 2.3 0 0 .16.05.43.06h.14c.69-.02 1.9-.37 3-2.26l-7.4-.25zm7.83-8.41c.14-2.06-1.94-3.97-1.94-3.98 0 0-3.85 4.66-6.67 10.8 0 0-.03.08.02.13l.04.01h.06c1.06-.53 5.46-2.77 7.28-4.54 0 0 1.15-.93 1.21-2.42zm1.52 2.14s-6.28 3.37-9.52 5.55c0 0-.05.04-.03.11 0 0 .03.06.07.06 1.16 0 5.56 0 5.67-.02 0 0 .57-.02 1.27-.29 0 0 1.56-.5 2.37-2.27 0 0 .73-1.45.17-3.14z';

function VendorMark({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  // Decorative: visible text label next to the mark is the accessible name.
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn('h-3 w-3 shrink-0 fill-current', className)}
    >
      <path d={path} />
    </svg>
  );
}

export function vendorDisplayLabel(
  vendor: AcceleratorVendor,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return vendor === 'nvidia'
    ? t('systemManager.gpu.vendor.nvidia')
    : t('systemManager.gpu.vendor.ascend');
}

/**
 * Vendor chip with brand vector mark (NVIDIA / Huawei Ascend).
 * Falls back to text for unknown vendors.
 */
export const GpuVendorBadge = memo(function GpuVendorBadge({
  vendor,
  className,
}: {
  vendor: AcceleratorVendor;
  className?: string;
}) {
  const { t } = useI18n();
  const label = vendorDisplayLabel(vendor, t);

  const mark = vendor === 'nvidia'
    ? <VendorMark path={NVIDIA_PATH} />
    : vendor === 'ascend'
      ? <VendorMark path={HUAWEI_PATH} />
      : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[10px] font-medium',
            // Match SystemPanelStatusBadge muted tone so logos stay legible.
            'bg-slate-500 text-white dark:bg-slate-400 dark:text-slate-950',
            className,
          )}
        >
          {mark}
          <span className="max-w-[4.5rem] truncate leading-none">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
