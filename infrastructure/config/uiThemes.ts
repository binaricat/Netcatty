export type UiThemeTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
};

export type UiThemePreset = {
  id: string;
  name: string;
  tokens: UiThemeTokens;
};

export const LIGHT_UI_THEMES: UiThemePreset[] = [
  {
    id: "snow",
    name: "Snow",
    tokens: {
      background: "216 33% 96%",
      foreground: "222 47% 12%",
      card: "0 0% 100%",
      cardForeground: "222 47% 12%",
      popover: "0 0% 100%",
      popoverForeground: "222 47% 12%",
      primary: "208 100% 50%",
      primaryForeground: "0 0% 100%",
      secondary: "220 16% 90%",
      secondaryForeground: "222 47% 12%",
      muted: "220 16% 90%",
      mutedForeground: "220 10% 45%",
      accent: "208 100% 50%",
      accentForeground: "222 47% 12%",
      destructive: "0 70% 50%",
      destructiveForeground: "0 0% 100%",
      border: "220 16% 82%",
      input: "220 16% 82%",
      ring: "208 100% 50%",
    },
  },
  {
    id: "pure-white",
    name: "Pure White",
    tokens: {
      background: "0 0% 100%",
      foreground: "222 47% 12%",
      card: "0 0% 100%",
      cardForeground: "222 47% 12%",
      popover: "0 0% 100%",
      popoverForeground: "222 47% 12%",
      primary: "210 90% 48%",
      primaryForeground: "0 0% 100%",
      secondary: "220 12% 95%",
      secondaryForeground: "222 47% 12%",
      muted: "220 12% 95%",
      mutedForeground: "220 10% 45%",
      accent: "210 90% 48%",
      accentForeground: "222 47% 12%",
      destructive: "0 70% 50%",
      destructiveForeground: "0 0% 100%",
      border: "220 12% 88%",
      input: "220 12% 88%",
      ring: "210 90% 48%",
    },
  },
  {
    id: "ivory",
    name: "Ivory",
    tokens: {
      background: "38 40% 95%",
      foreground: "222 47% 12%",
      card: "40 45% 98%",
      cardForeground: "222 47% 12%",
      popover: "40 45% 98%",
      popoverForeground: "222 47% 12%",
      primary: "28 85% 50%",
      primaryForeground: "0 0% 100%",
      secondary: "36 28% 90%",
      secondaryForeground: "222 47% 12%",
      muted: "36 28% 90%",
      mutedForeground: "220 10% 45%",
      accent: "28 85% 50%",
      accentForeground: "222 47% 12%",
      destructive: "0 70% 50%",
      destructiveForeground: "0 0% 100%",
      border: "34 24% 84%",
      input: "34 24% 84%",
      ring: "28 85% 50%",
    },
  },
];

export const DARK_UI_THEMES: UiThemePreset[] = [
  {
    id: "midnight",
    name: "Midnight",
    tokens: {
      background: "220 28% 8%",
      foreground: "210 40% 95%",
      card: "220 22% 12%",
      cardForeground: "210 40% 95%",
      popover: "220 22% 12%",
      popoverForeground: "210 40% 95%",
      primary: "200 100% 61%",
      primaryForeground: "220 40% 96%",
      secondary: "220 16% 16%",
      secondaryForeground: "210 40% 90%",
      muted: "220 16% 16%",
      mutedForeground: "220 10% 70%",
      accent: "200 100% 61%",
      accentForeground: "220 40% 96%",
      destructive: "0 70% 50%",
      destructiveForeground: "210 40% 96%",
      border: "220 22% 18%",
      input: "220 22% 18%",
      ring: "200 100% 61%",
    },
  },
  {
    id: "deep-blue",
    name: "Deep Blue",
    tokens: {
      background: "220 35% 10%",
      foreground: "210 40% 96%",
      card: "220 28% 14%",
      cardForeground: "210 40% 96%",
      popover: "220 28% 14%",
      popoverForeground: "210 40% 96%",
      primary: "210 90% 60%",
      primaryForeground: "220 40% 96%",
      secondary: "220 20% 18%",
      secondaryForeground: "210 40% 90%",
      muted: "220 20% 18%",
      mutedForeground: "220 10% 72%",
      accent: "210 90% 60%",
      accentForeground: "220 40% 96%",
      destructive: "0 70% 50%",
      destructiveForeground: "210 40% 96%",
      border: "220 20% 22%",
      input: "220 20% 22%",
      ring: "210 90% 60%",
    },
  },
  {
    id: "vscode",
    name: "VS Code",
    tokens: {
      background: "0 0% 12%",
      foreground: "210 20% 92%",
      card: "0 0% 16%",
      cardForeground: "210 20% 92%",
      popover: "0 0% 16%",
      popoverForeground: "210 20% 92%",
      primary: "210 90% 60%",
      primaryForeground: "0 0% 100%",
      secondary: "0 0% 18%",
      secondaryForeground: "210 20% 92%",
      muted: "0 0% 18%",
      mutedForeground: "0 0% 65%",
      accent: "210 90% 60%",
      accentForeground: "0 0% 100%",
      destructive: "0 70% 50%",
      destructiveForeground: "0 0% 100%",
      border: "0 0% 22%",
      input: "0 0% 22%",
      ring: "210 90% 60%",
    },
  },
];

export const getUiThemeById = (theme: "light" | "dark", id: string): UiThemePreset => {
  const list = theme === "dark" ? DARK_UI_THEMES : LIGHT_UI_THEMES;
  const found = list.find((preset) => preset.id === id);
  return found || list[0];
};
