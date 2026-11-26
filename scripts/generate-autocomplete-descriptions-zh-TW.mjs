/**
 * Regenerate the zh-TW autocomplete description overlay from the committed
 * zh-CN dictionary.
 *
 * Conversion is OpenCC s2twp: Simplified Chinese to Traditional Chinese
 * (Taiwan standard) with Taiwan phrases, for example 文件→檔案, 默认→預設,
 * 网络→網路. English dictionary keys are copied unchanged.
 *
 * OpenCC's TWPhrases entry for 進程 lists 程序 first, then 進程 and 行程.
 * opencc-js keeps that first candidate, so plain s2twp turns 进程 into 程序.
 * Command descriptions use the Taiwan IT term 行程 instead: 进程 is held out
 * of the converter and restored as 行程. 程序 in the source still follows
 * s2twp (程序→程式).
 *
 * opencc-js is a devDependency used only by this script. The renderer loads
 * the committed JSON and does not import opencc-js.
 *
 * Usage: node scripts/generate-autocomplete-descriptions-zh-TW.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenCC from "opencc-js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(
  rootDir,
  "components/terminal/autocomplete/descriptions.zh-CN.json",
);
const outputPath = path.join(
  rootDir,
  "components/terminal/autocomplete/descriptions.zh-TW.json",
);

function printfTokens(text) {
  return text.match(/%[-+ #0]*\d*(?:\.\d+)?[a-zA-Z]|%%/g) ?? [];
}

// Private-use mark so s2twp cannot rewrite 进程 before it becomes 行程.
const PROCESS_MARK = "\u{E000}";

// s2twp picks the wrong Taiwan term where the zh-CN phrase is ambiguous at a
// word boundary or where OpenCC only has a mainland form. Each entry is a
// literal post-conversion fix, applied after the 进程 placeholder is restored.
const TAIWAN_PHRASE_FIXES = [
  ["擴充套件正規表示式", "擴充正規表示式"],
  ["擴充套件 E3", "擴充 E3"],
  ["欄位連線", "欄位聯結"],
  ["二進位制資料", "二進位資料"],
  ["后綴", "字尾"],
  ["執行檔例項", "執行檔"],
  ["屏幕", "螢幕"],
  ["文本", "文字"],
  // Number bases and generic “extended” wording; Taiwan drops 制 and 套件.
  ["進位制", "進位"],
  ["擴充套件", "擴充"],
  // “instance” in the cloud-resource sense.
  ["例項", "執行個體"],
  // Side effects of the generic 擴充套件→擴充 rule.
  ["擴充頭", "擴充標頭"],
  ["ALPN TLS 擴充", "ALPN TLS 擴充功能"],
  ["NPN TLS 擴充", "NPN TLS 擴充功能"],
  ["數據", "資料"],
  // “extension” as a noun keeps 功能; the generic rule above only covers the
  // adjective “extended” (擴充屬性, 擴充正規表示式, 擴充標頭).
  ["Apple 的擴充", "Apple 的擴充功能"],
  ["（Apple 擴充）", "（Apple 擴充功能）"],
];

/**
 * OpenCC s2twp resolves a few ambiguous simplified characters to the wrong
 * Traditional form in command descriptions. Each pattern below is limited to
 * the sense these descriptions use; the committed-dictionary test asserts the
 * bad forms never reach descriptions.zh-TW.json.
 */
const POST_CONVERSION_CORRECTIONS = [
  // 隻 is a measure word (一隻鳥); these descriptions mean "only" (只).
  [/隻/g, "只"],
  // 髮 means hair; the source is 发送 (send).
  [/髮/g, "發"],
  // 錶 means a wristwatch; the source is 表现 (behave/appear).
  [/錶/g, "表"],
  // 复用 (reuse) is 復用; 複 stays for 複雜 and 複製.
  [/複用/g, "復用"],
  // "and/also" is 並為; 合併為 (merged into) keeps 併.
  [/(?<!合)併為/g, "並為"],
  // 后 is a queen; the source is 后 (after), which is 後 in Traditional.
  [/后/g, "後"],
  // Taiwan util-linux wording.
  [/塊裝置/g, "區塊裝置"],
  [/分割槽表/g, "分割表"],
];

function applyPostConversionCorrections(text) {
  let corrected = text;
  for (const [pattern, replacement] of POST_CONVERSION_CORRECTIONS) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected;
}

function toTraditionalTaiwan(text, convert) {
  if (text.includes(PROCESS_MARK)) {
    throw new Error("description already contains the 进程 placeholder");
  }
  const marked = text.replaceAll("进程", PROCESS_MARK);
  const converted = convert(marked);
  if (converted.includes("进程") || (marked.includes(PROCESS_MARK) && !converted.includes(PROCESS_MARK))) {
    throw new Error("OpenCC dropped the 进程 placeholder");
  }
  let traditional = converted.replaceAll(PROCESS_MARK, "行程");
  for (const [from, to] of TAIWAN_PHRASE_FIXES) {
    traditional = traditional.replaceAll(from, to);
  }
  // Phrase fixes run first so 后綴→字尾 is not broken by the 后→後 rule.
  return applyPostConversionCorrections(traditional);
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!source || typeof source !== "object" || Array.isArray(source)) {
  throw new Error("zh-CN description dictionary must be a JSON object");
}

// Keep reviewed cp wording scoped to its description keys.
const descriptionOverrides = new Map([
  ["Copy all source arguments into the target directory", "將所有來源引數複製到目標目錄"],
  ["Copy directories recursively (legacy option; prefer -R for portability)", "遞迴複製目錄及其內容（舊版相容選項，跨平台使用時建議使用 -R）"],
  ["Copy directories recursively; a trailing slash on the source copies only its contents", "遞迴複製目錄及其內容；來源目錄以 / 結尾時只複製目錄內容"],
  ["Copy files and directories", "複製檔案和目錄"],
  ["Copy only when the source is newer than the destination", "僅當來源檔案比目標新時才複製"],
  ["Copy source symbolic links without following them", "複製來源符號連結本身，無須跟隨連結"],
  ["Control how sparse source files are expanded", "控制稀疏來源檔案的展開方式"],
  ["Do not copy Extended Attributes (EAs) or resource forks", "不複製擴充屬性（EA）或資源分支"],
  ["Follow all symbolic links in the source", "跟隨來源檔案和目錄中的所有符號連結"],
  ["Follow only symbolic links given as source arguments", "僅跟隨以來源引數傳入的符號連結"],
  ["Finds files matching a given query", "尋找符合指定查詢的檔案"],
  ["If the destination cannot be opened, remove it and retry the copy", "若無法開啟目標檔案，則刪除該檔案並重試複製"],
  ["Preserve file attributes such as permissions, ownership, and timestamps", "保留權限、所有者和所屬組、時間戳等檔案屬性"],
  ["Preserve permissions, ownership, and timestamps", "保留權限、所有者和所屬組及時間戳"],
  ["Prompt before overwriting an existing file", "覆蓋已有檔案前提示確認"],
  ["Remove trailing slashes from source arguments", "去除來源引數末尾的斜線"],
]);

const missingOverrideKeys = [...descriptionOverrides.keys()].filter((key) => !(key in source));
if (missingOverrideKeys.length > 0) {
  throw new Error(`Override keys missing from the zh-CN dictionary: ${missingOverrideKeys.join(", ")}`);
}

const convert = OpenCC.Converter({ from: "cn", to: "twp" });
const converted = {};

for (const [key, value] of Object.entries(source)) {
  if (typeof value !== "string") {
    throw new Error(`Expected a string value for ${JSON.stringify(key)}`);
  }
  const traditional = descriptionOverrides.get(key) ?? toTraditionalTaiwan(value, convert);
  const sourceTokens = printfTokens(value);
  const convertedTokens = printfTokens(traditional);
  if (sourceTokens.join(" ") !== convertedTokens.join(" ")) {
    throw new Error(
      `Printf placeholders changed for ${JSON.stringify(key)}: ${sourceTokens.join(" ")} -> ${convertedTokens.join(" ")}`,
    );
  }
  converted[key] = traditional;
}

fs.writeFileSync(outputPath, `${JSON.stringify(converted, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(converted).length} zh-TW descriptions to ${path.relative(rootDir, outputPath)}`,
);
