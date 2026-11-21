"use strict";

/**
 * Vendor assistant site registry.
 *
 * Every entry describes one vendor's public AI assistant page: where the
 * composer lives, how a question is submitted, and which element carries the
 * answer. The selectors are verified against the live sites; when a vendor
 * redesigns its page this entry is the only thing that needs updating.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** Selector helper shared by every generated script. */
const LOOKUP_JS = `
  const lookup = (list, all) => {
    for (const sel of list) {
      let found = [];
      try {
        if (sel.startsWith('text=')) {
          const label = sel.slice(5).trim();
          const nodes = document.querySelectorAll('button, a, div, span');
          for (const node of nodes) {
            const text = (node.innerText || '').trim();
            if (text === label && node.offsetParent !== null) found.push(node);
          }
        } else {
          found = Array.from(document.querySelectorAll(sel));
        }
      } catch (e) {
        found = [];
      }
      if (found.length) {
        return all ? found : found[0];
      }
    }
    return all ? [] : null;
  };
  // Presence is not readiness: vendor widgets keep their panels mounted but
  // hidden behind visibility/opacity until the entry button is clicked.
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
  };
`;

const VENDORS = [
  {
    key: "huawei",
    name: "Huawei WeiKnow",
    url: "https://weiknow.gts.huawei.com/weiknow/#/question?locale=zh_CN&lang=zh&source=Forum",
    needsQuery: false,
    initJs: null,
    // The signed-in landing page has no composer until "新建对话" is opened.
    click: ["[class*='new-dialog']", "text=新建对话"],
    panel: [],
    dismiss: [],
    // Not a textarea: a contenteditable div whose attribute value is empty.
    input: ["div.multi-input", "[contenteditable]", "textarea"],
    // Clicking the send button does not submit; Enter does.
    sendClick: [],
    pressEnter: true,
    // Every turn stays on the page, so the latest one carries the answer.
    answer: ["div.gptContent"],
    answerLastChild: false,
    answerLastMatch: true,
    busy: [],
    doneMarker: null,
    loginUrlMarkers: ["uniportal", "login-pc", "sso"],
    loginTextMarkers: ["请登录", "登录后"],
  },
  {
    key: "ruijie",
    name: "Ruijie AZAI",
    url: "https://www.ruijie.com.cn/fw/",
    needsQuery: false,
    // Guests are sampled by the entry script; pre-set the flag it looks for.
    initJs: "try{localStorage.setItem('azai-guest-random-gate:allowed','1')}catch(e){}",
    // Avatar opens the panel, which then asks which service to use; the AZAI
    // chat only appears after picking the digital employee.
    click: [".AI-tips__avatar", ".AI-tips__hello", "text=阿在-数字员工"],
    panel: ["#AI-panel-messages"],
    dismiss: [
      // The site opens a full-viewport survey overlay that swallows every
      // click, including the AI entry button underneath it.
      ".n-mask-btn",
      ".n-survey .n-mask-btn",
      // Consent dialog: the box starts disabled, so the agree click has to
      // happen before the continue click in the same pass.
      ".privacy-check",
      ".ai-privacy__agree",
      'button.ai-privacy__agree[data-action="toggle-agree"]',
      ".ai-privacy__submit",
      "button.ai-privacy__submit",
      // The privacy card can also arrive after the chat is already open.
      "text=我同意锐捷隐私声明",
      "text=继续使用",
    ],
    input: ["textarea.AI-panel__input", "#AI-panel textarea"],
    sendClick: [
      'button.AI-panel__send[aria-label="发送"]',
      "button.AI-panel__send",
    ],
    pressEnter: true,
    // The transcript keeps older turns and renders each turn twice.
    answer: ["#AI-panel-messages"],
    answerLastChild: true,
    answerLastMatch: false,
    // The send button turns into a stop button while streaming.
    busy: ["button.AI-panel__send.is-stop"],
    doneMarker: null,
    loginUrlMarkers: ["login", "passport"],
    loginTextMarkers: ["请登录"],
  },
  {
    key: "h3c",
    name: "H3C Zhiliao",
    // The iClaw entry lives on the Zhiliao community site; ai.h3c.com only
    // redirects to the SSO page now.
    url: "https://zhiliao.h3c.com/Intelligence/index",
    needsQuery: false,
    initJs: null,
    click: [],
    panel: [],
    // Asking while signed out opens a modal that would block the composer.
    dismiss: ["text=确定", ".el-dialog__headerbtn", ".el-message-box__btns button"],
    input: [
      "textarea#input_content_1",
      "textarea#input_content",
      "textarea.input_content",
      "textarea",
    ],
    sendClick: [],
    pressEnter: true,
    answer: ["#chatCont"],
    answerLastChild: true,
    answerLastMatch: false,
    busy: ["div.chatL.running"],
    doneMarker: null,
    loginUrlMarkers: ["ssologin", "sso.", "/login", "signin"],
    loginTextMarkers: ["请您先登录知了社区", "登录后才可以操作"],
  },
  {
    key: "juniper",
    name: "Juniper Ask AI",
    url: "https://www.juniper.net/us/en/dm/ask-ai.html",
    needsQuery: false,
    initJs: null,
    click: ["button.ask-ai-btn", "text=Ask AI"],
    panel: [],
    dismiss: [],
    input: ["#promptInput", "textarea", "div[contenteditable]"],
    sendClick: [],
    pressEnter: true,
    answer: ["#resultContainer", "main"],
    answerLastChild: false,
    answerLastMatch: false,
    busy: [],
    doneMarker: null,
    loginUrlMarkers: ["login", "signin"],
    loginTextMarkers: ["Sign in", "sign in"],
  },
  {
    key: "aruba",
    name: "Aruba Ask AI",
    url: "https://www.arubanetworks.com/ask-ai/",
    needsQuery: false,
    initJs: null,
    click: ["div.ai-modal-trigger", "button.ask-ai-btn", "text=Ask AI"],
    panel: [],
    dismiss: [],
    input: ["#promptInput", "textarea", "div[contenteditable]"],
    sendClick: [],
    pressEnter: true,
    answer: ["#resultContainer", "main"],
    answerLastChild: false,
    answerLastMatch: false,
    busy: [],
    doneMarker: null,
    loginUrlMarkers: ["login", "signin"],
    loginTextMarkers: ["Sign in", "sign in"],
  },
  {
    key: "cisco",
    name: "Cisco Search",
    url: "https://search.cisco.com/search?query={q}",
    needsQuery: true,
    initJs: null,
    click: [],
    panel: [],
    dismiss: [],
    input: [],
    sendClick: [],
    pressEnter: false,
    answer: ["main"],
    answerLastChild: false,
    answerLastMatch: false,
    busy: [],
    doneMarker: "Results generated by AI",
    loginUrlMarkers: ["login", "signin"],
    loginTextMarkers: ["Sign in"],
  },
];

const ALIASES = {
  huawei: ["huawei", "华为", "weiknow"],
  ruijie: ["ruijie", "锐捷", "azai", "阿在"],
  h3c: ["h3c", "华三", "新华三", "zhiliao", "知了"],
  juniper: ["juniper", "瞻博"],
  aruba: ["aruba", "阿鲁巴"],
  cisco: ["cisco", "思科"],
};

/** Resolves a vendor key, name or alias to its spec. */
function resolve(vendor) {
  const needle = String(vendor || "").trim().toLowerCase();
  if (!needle) return null;
  const direct = VENDORS.find((spec) => spec.key === needle);
  if (direct) return direct;
  for (const spec of VENDORS) {
    const aliases = ALIASES[spec.key] || [];
    if (aliases.some((alias) => alias.toLowerCase() === needle)) return spec;
    if (spec.name.toLowerCase().includes(needle)) return spec;
  }
  return VENDORS.find((spec) =>
    (ALIASES[spec.key] || []).some((alias) => alias.toLowerCase().includes(needle) || needle.includes(alias.toLowerCase())),
  ) || null;
}

const LOGIN_MARKER = ".logged-in";

/**
 * Profile root for persistent vendor logins.
 *
 * Reuses AITerminal's profiles when present so an existing sign-in does not
 * have to be repeated, then falls back to the Netcatty user data directory.
 */
function defaultProfileRoot() {
  const fromEnv = process.env.NETCATTY_VENDOR_PROFILE_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const shared = path.join(home, ".aiterminal", "assistant_profiles");
    try {
      if (fs.statSync(shared).isDirectory()) return shared;
    } catch {
      // No shared profiles on this machine.
    }
  }
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, "Netcatty", "vendor-assistant");
}

function profileDir(vendor, root = defaultProfileRoot()) {
  return path.join(root, vendor);
}

/** logged | unknown | missing */
function loginState(vendor, root = defaultProfileRoot()) {
  const dir = profileDir(vendor, root);
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    return { state: "missing", dir };
  }
  if (!isDir) return { state: "missing", dir };
  try {
    const stat = fs.statSync(path.join(dir, LOGIN_MARKER));
    if (stat.isFile()) return { state: "logged", dir, at: stat.mtimeMs };
  } catch {
    // Directory exists but no sign-in was ever confirmed.
  }
  return { state: "unknown", dir };
}

function markLoggedIn(vendor, root = defaultProfileRoot()) {
  const dir = profileDir(vendor, root);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOGIN_MARKER), new Date().toISOString(), "utf8");
  } catch {
    // A read-only profile directory only loses the marker, not the question.
  }
}

function probeScript(spec) {
  return `(() => {
  const inputs = ${JSON.stringify(spec.input)};
  const answers = ${JSON.stringify(spec.answer)};
  const busySelectors = ${JSON.stringify(spec.busy)};
  const panelSelectors = ${JSON.stringify(spec.panel)};
  const loginText = ${JSON.stringify(spec.loginTextMarkers)};
  ${LOOKUP_JS}
  const box = lookup(inputs, false);
  const matches = lookup(answers, true);
  const holder = matches.length ? (${spec.answerLastMatch ? "true" : "false"} ? matches[matches.length - 1] : matches[0]) : null;
  let text = '';
  if (holder) {
    if (${spec.answerLastChild ? "true" : "false"}) {
      const kids = holder.children;
      text = kids.length ? (kids[kids.length - 1].innerText || '') : '';
    } else {
      text = holder.innerText || '';
    }
  }
  const body = document.body ? (document.body.innerText || '') : '';
  const login = loginText.some((marker) => body.includes(marker));
  const busyEl = lookup(busySelectors, false);
  const panelEl = panelSelectors.length ? lookup(panelSelectors, false) : true;
  return JSON.stringify({
    hasBox: visible(box),
    panel: panelSelectors.length ? visible(panelEl) : true,
    answer: text,
    busy: !!busyEl,
    login: login,
    url: location.href,
    title: document.title,
    bodyTail: body.slice(-2000)
  });
})()`;
}

/**
 * Puts the question into the composer.
 *
 * The vendor pages are framework apps: assigning value directly leaves the
 * component state untouched, so the native setter is used and an input event is
 * dispatched, which is what those frameworks listen to.
 */
function typeScript(spec, text) {
  return `(() => {
  const inputs = ${JSON.stringify(spec.input)};
  const text = ${JSON.stringify(text)};
  ${LOOKUP_JS}
  const el = lookup(inputs, false);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }
  return true;
})()`;
}

function valueScript(spec) {
  return `(() => {
  const inputs = ${JSON.stringify(spec.input)};
  ${LOOKUP_JS}
  const el = lookup(inputs, false);
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input') return el.value || '';
  return el.textContent || '';
})()`;
}

/**
 * Reports the viewport centre of the first visible candidate for every
 * selector, so the caller can dispatch real mouse clicks. Framework apps
 * sometimes ignore synthetic element.click() on plain divs.
 */
function pointsScript(selectors) {
  if (!selectors || !selectors.length) return null;
  return `(() => {
  const list = ${JSON.stringify(selectors)};
  ${LOOKUP_JS}
  const points = [];
  for (const sel of list) {
    const el = lookup([sel], false);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    points.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }
  return JSON.stringify(points);
})()`;
}

/**
 * Clicks candidates from page script.
 *
 * Real mouse events are the first choice, but overlays whose own handlers read
 * trusted clicks (survey popups, consent cards) still respond to a plain
 * element.click(), so both paths are tried.
 */
function jsClickScript(selectors) {
  if (!selectors || !selectors.length) return null;
  return `(() => {
  const list = ${JSON.stringify(selectors)};
  ${LOOKUP_JS}
  let clicked = 0;
  for (const sel of list) {
    const el = lookup([sel], false);
    if (!el) continue;
    try {
      el.click();
      clicked += 1;
    } catch (e) {}
  }
  return clicked;
})()`;
}

const SIGN_IN = {
  user: [
    "#username",
    'input[name="username"]',
    'input[name="account"]',
    'input[name="loginName"]',
    'input[placeholder*="账号"]',
    'input[placeholder*="用户名"]',
    'input[placeholder*="手机"]',
    'input[placeholder*="邮箱"]',
    'input[type="text"]',
  ],
  pass: [
    "#password",
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="密码"]',
  ],
  submit: [
    'text=登录',
    'button[type="submit"]',
    ".login-btn",
    ".btn-login",
    'text=Sign in',
  ],
};

const ACCOUNTS_FILE = "accounts.json";

/**
 * Reads the saved vendor accounts.
 *
 * Lookup order: NETCATTY_VENDOR_ACCOUNTS, the Netcatty profile root, then the
 * account file AITerminal already manages next to the shared browser profiles.
 * Passwords may be stored as "b64:<base64>" so plain files never hold the raw
 * value.
 */
function accounts(vendor, root = defaultProfileRoot()) {
  const candidates = [];
  if (process.env.NETCATTY_VENDOR_ACCOUNTS) candidates.push(process.env.NETCATTY_VENDOR_ACCOUNTS);
  candidates.push(path.join(root, ACCOUNTS_FILE));
  try {
    candidates.push(path.join(os.homedir(), ".aiterminal", "settings.json"));
  } catch {
    // No home directory: the shared file simply is not available.
  }
  for (const file of candidates) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const table = (data && (data.vendor_accounts || data.vendorAccounts)) || data;
    const entry = table && table[vendor];
    if (!entry || !entry.username) continue;
    let { password } = entry;
    password = typeof password === "string" ? password : "";
    if (password.startsWith("b64:")) {
      password = Buffer.from(password.slice(4), "base64").toString("utf8");
    }
    return { username: String(entry.username), password };
  }
  return null;
}

/** Fills the sign-in form with native setters so framework apps notice it. */
function fillSignInScript(user, password) {
  return `(() => {
  const userSelectors = ${JSON.stringify(SIGN_IN.user)};
  const passSelectors = ${JSON.stringify(SIGN_IN.pass)};
  ${LOOKUP_JS}
  const setValue = (el, value) => {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const user = lookup(userSelectors, false);
  const pass = lookup(passSelectors, false);
  if (!user || !pass) return JSON.stringify({ filled: false, user: !!user, pass: !!pass });
  setValue(user, ${JSON.stringify(user)});
  setValue(pass, ${JSON.stringify(password)});
  return JSON.stringify({ filled: true, user: true, pass: true });
})()`;
}

/** Reports whether the current page is a sign-in form. */
function signInFormScript() {
  return `(() => {
  const userSelectors = ${JSON.stringify(SIGN_IN.user)};
  const passSelectors = ${JSON.stringify(SIGN_IN.pass)};
  ${LOOKUP_JS}
  const user = lookup(userSelectors, false);
  const pass = lookup(passSelectors, false);
  return JSON.stringify({ user: !!user, pass: !!pass });
})()`;
}

module.exports = {
  VENDORS,
  ALIASES,
  LOGIN_MARKER,
  SIGN_IN,
  resolve,
  defaultProfileRoot,
  profileDir,
  loginState,
  markLoggedIn,
  accounts,
  fillSignInScript,
  signInFormScript,
  probeScript,
  typeScript,
  valueScript,
  pointsScript,
  jsClickScript,
};
