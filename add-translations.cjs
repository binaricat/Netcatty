const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'application', 'i18n', 'locales');
const locales = ['en', 'ru', 'zh-CN', 'zh-TW'];

const newKeysEn = `
  // AI Antigravity
  'ai.antigravity': 'Antigravity',
  'ai.antigravity.title': 'Antigravity SDK',
  'ai.antigravity.description': 'Connect Google Antigravity SDK. Once detected, it can be selected as an external coding agent.',
  'ai.antigravity.notFound': 'Harness not found',
  'ai.antigravity.notFoundHint': 'Specify the path to the localharness binary (e.g. /tmp/agy-sdk/google/antigravity/bin/localharness).',
  'ai.antigravity.check': 'Check',
`;

const newKeysRu = `
  // AI Antigravity
  'ai.antigravity': 'Antigravity',
  'ai.antigravity.title': 'Antigravity SDK',
  'ai.antigravity.description': 'Подключение Google Antigravity SDK. После обнаружения его можно выбрать в качестве внешнего агента.',
  'ai.antigravity.notFound': 'Harness не найден',
  'ai.antigravity.notFoundHint': 'Укажите путь к бинарному файлу localharness (например, /tmp/agy-sdk/google/antigravity/bin/localharness).',
  'ai.antigravity.check': 'Проверить',
`;

const newKeysZhCn = `
  // AI Antigravity
  'ai.antigravity': 'Antigravity',
  'ai.antigravity.title': 'Antigravity SDK',
  'ai.antigravity.description': '接入 Google Antigravity SDK。检测到后即可作为外部编程 Agent 使用。',
  'ai.antigravity.notFound': '未找到 Harness',
  'ai.antigravity.notFoundHint': '指定 localharness 二进制文件的路径 (例如 /tmp/agy-sdk/google/antigravity/bin/localharness)。',
  'ai.antigravity.check': '检查',
`;

const newKeysZhTw = `
  // AI Antigravity
  'ai.antigravity': 'Antigravity',
  'ai.antigravity.title': 'Antigravity SDK',
  'ai.antigravity.description': '介接 Google Antigravity SDK。偵測到後即可作為外部程式設計 Agent 使用。',
  'ai.antigravity.notFound': '未找到 Harness',
  'ai.antigravity.notFoundHint': '指定 localharness 二進位檔案的路徑 (例如 /tmp/agy-sdk/google/antigravity/bin/localharness)。',
  'ai.antigravity.check': '檢查',
`;

const map = {
  'en': newKeysEn,
  'ru': newKeysRu,
  'zh-CN': newKeysZhCn,
  'zh-TW': newKeysZhTw
};

for (const loc of locales) {
  const filePath = path.join(localesDir, loc, 'ai.ts');
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes("'ai.antigravity.description'")) {
      content = content.replace(/(?=\s*\/\/ AI Codex)/, map[loc]);
      fs.writeFileSync(filePath, content);
      console.log('Updated', loc);
    } else {
      console.log('Already updated', loc);
    }
  }
}
