export type XTermFontRemeasureTarget = {
  _core?: {
    _charSizeService?: {
      measure?: () => void;
    };
  };
  options?: {
    fontSize?: number;
  };
};

export function forceXTermFontRemeasure(term: XTermFontRemeasureTarget): boolean {
  const charSizeService = term._core?._charSizeService;
  if (typeof charSizeService?.measure === "function") {
    charSizeService.measure();
    return true;
  }

  const options = term.options;
  const fontSize = options?.fontSize;
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) return false;

  // xterm remeasures fonts when fontSize changes. Nudge and restore the value
  // so the measurement path runs without changing the user's effective size.
  options.fontSize = fontSize + 0.001;
  options.fontSize = fontSize;
  return true;
}
