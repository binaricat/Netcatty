import en, { type Messages } from './locales/en';
import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';
import ru from './locales/ru';
import es from './locales/es';

// Keep keys stable; add new locales by adding another import and map entry.
export { type Messages };

export const MESSAGES_BY_LOCALE: Record<string, Messages> = {
  en,
  ru,
  es,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

