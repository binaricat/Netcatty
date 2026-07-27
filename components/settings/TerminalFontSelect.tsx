import React, { useMemo, useSyncExternalStore } from 'react';
import {
  extractPrimaryFamily,
  getFontAvailabilityVersion,
  hasAuthoritativeData,
  isFontInstalled,
  subscribeFontAvailability,
} from '../../lib/fontAvailability';
import type { TerminalFont } from '../../infrastructure/config/fonts';
import { FontSelect } from './FontSelect';

interface TerminalFontSelectProps {
  value: string;
  fonts: TerminalFont[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel: string;
}

export const TerminalFontSelect: React.FC<TerminalFontSelectProps> = ({
  value,
  fonts,
  onChange,
  className,
  disabled,
  ariaLabel,
}) => {
  // Subscribe to font availability so the filter re-evaluates after the
  // Local Font Access API populates the authoritative install set
  // asynchronously, even if the `fonts` prop ref hasn't changed.
  const availabilityVersion = useSyncExternalStore(
    subscribeFontAvailability,
    getFontAvailabilityVersion,
    getFontAvailabilityVersion,
  );

  // Hide fonts that aren't actually rendered on this machine so users
  // don't pick a font and then see no visible change. The currently
  // selected font is always shown so the user can read their setting.
  //
  // When the Local Font Access API has populated authoritative data,
  // trust it: an empty or near-empty result means the user really has
  // few monospace fonts (Layer 3 still gives at least one option via
  // bundled Sarasa Mono SC). When canvas-only fallback is in play,
  // we keep a safety net at length>=1 to avoid an empty dropdown if
  // detection misfires.
  const visibleFonts = useMemo(() => {
    // Referenced so eslint-react-hooks sees the dep used; the real
    // purpose is to invalidate this memo when setSystemFamilies bumps
    // the version (isFontInstalled reads module state).
    void availabilityVersion;
    const filtered = fonts.filter(
      (font) => font.id === value || isFontInstalled(extractPrimaryFamily(font.family)),
    );
    if (hasAuthoritativeData()) return filtered;
    return filtered.length >= 1 ? filtered : fonts;
  }, [fonts, value, availabilityVersion]);

  return (
    <FontSelect
      fonts={visibleFonts}
      value={value}
      onChange={onChange}
      className={className}
      disabled={disabled}
      ariaLabel={ariaLabel}
    />
  );
};

export default TerminalFontSelect;
