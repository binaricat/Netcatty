export interface NoteFontOption {
  id: string;
  family: string;
}

export const resolveNoteFontFamily = (
  fonts: NoteFontOption[],
  storedValue: string,
): string => {
  if (!storedValue) return "";
  return fonts.find((font) => font.family === storedValue)?.family
    ?? fonts.find((font) => font.id === storedValue)?.family
    ?? "";
};

export const resolveNoteFontSelectionId = (
  fonts: NoteFontOption[],
  storedValue: string,
): string => fonts.find((font) => font.family === storedValue)?.id
  ?? fonts.find((font) => font.id === storedValue)?.id
  ?? "";

export const resolveNoteFontSelectionFamily = (
  fonts: NoteFontOption[],
  selectedId: string,
): string => fonts.find((font) => font.id === selectedId)?.family ?? "";
