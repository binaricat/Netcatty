import en, { type Messages } from './locales/en';
import zhCN from './locales/zh-CN';
import ru from './locales/ru';

// Keep keys stable; add new locales by adding another import and map entry.
export { type Messages };

export const MESSAGES_BY_LOCALE: Record<string, Messages> = {
  en,
  ru,
  'zh-CN': zhCN,
};

