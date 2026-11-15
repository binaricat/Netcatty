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
  const converted = applyPostConversionCorrections(convert(marked));
  if (converted.includes("进程") || (marked.includes(PROCESS_MARK) && !converted.includes(PROCESS_MARK))) {
    throw new Error("OpenCC dropped the 进程 placeholder");
  }
  return converted.replaceAll(PROCESS_MARK, "行程");
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
