// Created: 2026-07-15
// Purpose: verify keyboard-interactive modal server prompt formatting.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatKeyboardInteractiveServerPrompt } from "./KeyboardInteractiveModal.tsx";

const modalSource = readFileSync(new URL("./KeyboardInteractiveModal.tsx", import.meta.url), "utf8");

test("formatKeyboardInteractiveServerPrompt preserves server instructions and prompt labels", () => {
  const text = formatKeyboardInteractiveServerPrompt({
    hostname: "192.168.9.138",
    name: "Keyboard-interactive authentication prompts from server",
    instructions: "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
    prompts: [
      {
        prompt: "Secondary Authentication Password:",
        echo: false,
      },
    ],
  });

  assert.equal(
    text,
    [
      "Keyboard-interactive authentication prompts from server:",
      "| 为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
      "| Secondary Authentication Password:",
    ].join("\n"),
  );
});

test("formatKeyboardInteractiveServerPrompt omits hostname-only fallback prompts", () => {
  const text = formatKeyboardInteractiveServerPrompt({
    hostname: "192.168.9.138",
    name: "192.168.9.138",
    instructions: "",
    prompts: [
      {
        prompt: "Password:",
        echo: false,
      },
    ],
  });

  assert.equal(text, "");
});

test("keyboard-interactive modal cannot be dismissed by outside click or Escape", () => {
  assert.match(modalSource, /onOpenChange=\{\(\) => \{\/\* intentionally non-dismissable \*\/\}\}/);
  assert.match(modalSource, /onInteractOutside=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(modalSource, /onEscapeKeyDown=\{\(e\) => e\.preventDefault\(\)\}/);
});

test("keyboard-interactive modal pre-checks save only on the post-failed-auto-fill retry (#3556)", () => {
  // The default comes from the bridge (defaultSavePassword) and must still
  // require a password slot to save into.
  assert.match(modalSource, /setSavePassword\(Boolean\(request\.defaultSavePassword\) && passwordPromptIndex >= 0\)/);
});

test("isAPasswordPrompt recognizes CJK password slots like sshAuthHelper PASSWORD_PROMPT_PATTERN (#3558)", () => {
  // The modal must count "密码：" / "口令：" prompts as password slots so
  // defaultSavePassword is honored for Chinese-localized PAM challenges.
  assert.match(modalSource, /passw\(or\)\?d\|密\\s\*码\|口\\s\*令/);
  // CJK second-factor wording must still be excluded (aligned with
  // OTP_PROMPT_PATTERN in sshAuthHelper.cjs).
  for (const blocked of ["动态", "一次性", "验证码", "令牌", "双因素", "二次", "安全密码", "挑战码"]) {
    assert.match(modalSource, new RegExp(`lower\\.includes\\("${blocked}"\\)`));
  }
});
