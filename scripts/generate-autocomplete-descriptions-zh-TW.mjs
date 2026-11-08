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
];

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
  return traditional;
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!source || typeof source !== "object" || Array.isArray(source)) {
  throw new Error("zh-CN description dictionary must be a JSON object");
}

const convert = OpenCC.Converter({ from: "cn", to: "twp" });
const converted = {};

for (const [key, value] of Object.entries(source)) {
  if (typeof value !== "string") {
    throw new Error(`Expected a string value for ${JSON.stringify(key)}`);
  }
  const traditional = toTraditionalTaiwan(value, convert);
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
