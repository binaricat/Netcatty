type ParsedHslToken = {
  hue: number;
  saturation: number;
  lightness: number;
};

const BLACK_HSL = '0 0% 0%';
const WHITE_HSL = '0 0% 100%';

const parseHslToken = (value: string): ParsedHslToken | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(value);
  if (!match) return null;
  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const lightness = Number(match[3]);
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  return {
    hue: ((hue % 360) + 360) % 360,
    saturation: Math.min(100, Math.max(0, saturation)) / 100,
    lightness: Math.min(100, Math.max(0, lightness)) / 100,
  };
};

const hslToRgb = ({ hue, saturation, lightness }: ParsedHslToken): [number, number, number] => {
  if (saturation === 0) return [lightness, lightness, lightness];

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [red, green, blue] =
    huePrime < 1 ? [chroma, x, 0] :
    huePrime < 2 ? [x, chroma, 0] :
    huePrime < 3 ? [0, chroma, x] :
    huePrime < 4 ? [0, x, chroma] :
    huePrime < 5 ? [x, 0, chroma] :
    [chroma, 0, x];
  const match = lightness - chroma / 2;
  return [red + match, green + match, blue + match];
};

const toLinearSrgb = (channel: number): number => (
  channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
);

export const getHslTokenRelativeLuminance = (value: string): number | null => {
  const parsed = parseHslToken(value);
  if (!parsed) return null;
  const [red, green, blue] = hslToRgb(parsed).map(toLinearSrgb);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const getContrastRatio = (foregroundLuminance: number, backgroundLuminance: number): number => {
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

export const resolveReadableForegroundForHsl = (
  backgroundHsl: string,
  fallback: string = WHITE_HSL,
): string => {
  const backgroundLuminance = getHslTokenRelativeLuminance(backgroundHsl);
  if (backgroundLuminance == null) return fallback;

  const blackContrast = getContrastRatio(0, backgroundLuminance);
  const whiteContrast = getContrastRatio(1, backgroundLuminance);
  return whiteContrast >= blackContrast ? WHITE_HSL : BLACK_HSL;
};

export function hexToHslToken(hex: string): string {
  const normalized = hex.startsWith('#') ? hex : `#${hex}`;
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

export function adjustLightnessToken(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const newL = Math.max(0, Math.min(100, parseFloat(parts[2]) + delta));
  return `${parts[0]} ${parts[1]} ${Math.round(newL * 10) / 10}%`;
}

export function adjustSaturationToken(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const newS = Math.max(0, Math.min(100, parseFloat(parts[1]) * factor));
  return `${parts[0]} ${Math.round(newS * 10) / 10}% ${parts[2]}`;
}
