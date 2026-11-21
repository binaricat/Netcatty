"use strict";

/**
 * Drives a signed-in browser profile through the Chrome DevTools Protocol and
 * returns the vendor assistant's answer text.
 *
 * A call launches the user's own Chromium-family browser with a persistent
 * profile, opens the vendor assistant page, types the question, waits for the
 * answer to settle and shuts the browser down again.
 */

const { CdpError, CdpSession, findBrowser, launchBrowser, sleep } = require("./cdp.cjs");
const specs = require("./specs.cjs");

const POLL_INTERVAL_MS = 700;
const COMPOSER_TIMEOUT_MS = 45000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_QUESTION_CHARS = 500;
const MIN_ANSWER_CHARS = 60;
// End-of-answer punctuation (plus closing marks) used to tell "still streaming"
// apart from "finished": sites pause between chunks without setting a busy flag.
const ANSWER_BOUNDARY = /[。！？；：!?;:)\]】」』"`*]\s*$/;

const HANDOFF_MARKERS = [
  "转接人工",
  "转人工",
  "人工工程师",
  "联系人工",
  "人工客服",
  "抱歉，您反复",
  "抱歉，关于",
  "似乎没有解决",
  "换个角度",
  "暂时无法",
  "无法回答",
];

const CAPTCHA_MARKERS = ["验证码", "captcha", "短信验证", "扫码登录", "安全验证"];

const LEADING_NOISE = ["已生成答案", "阿在已完成", "正在思考", "思考中"];

/**
 * Sign-in windows left open for the user, keyed by vendor.
 *
 * Some vendors hand out a composer before a sign-in, so "the page is ready" is
 * not proof of a sign-in. Those windows stay open so the user can finish by
 * hand, and the next call for that vendor reclaims the browser because a
 * profile directory cannot be driven by two browsers at once.
 */
const lingeringLogins = new Map();

/** Kills a sign-in window left open for the vendor, if any. */
async function closeLingeringLogin(vendor) {
  const entry = lingeringLogins.get(vendor);
  if (!entry) return;
  lingeringLogins.delete(vendor);
  try {
    await entry.session.close();
  } catch {
    // The window may already be gone.
  }
  try {
    entry.child.kill();
  } catch {
    // Already gone.
  }
}

const STATUS = Object.freeze({
  OK: "ok",
  DISABLED: "disabled",
  NO_ASSISTANT: "no_assistant",
  NEED_LOGIN: "need_login",
  SELECTOR: "selector",
  TIMEOUT: "timeout",
  CAPTCHA: "captcha",
  NO_ANSWER: "no_answer",
  BLOCKED: "blocked",
  ERROR: "error",
});

const STATUS_CODES = Object.freeze({
  ok: 0,
  error: 1,
  no_assistant: 2,
  need_login: 3,
  selector: 4,
  timeout: 5,
  captcha: 6,
  blocked: 7,
  no_answer: 8,
  disabled: 9,
});

function sanitizeQuestion(question) {
  const text = String(question || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_QUESTION_CHARS);
}

/** Strips the question echo, status badges and trailing site chrome. */
function cleanAnswer(text, question) {
  let body = String(text || "").trim();
  if (!body) return "";
  const asked = String(question || "").trim();
  const probe = asked.length > 24 ? asked.slice(0, 24) : asked;
  if (probe.length >= 6) {
    const index = body.lastIndexOf(probe);
    if (index >= 0) {
      const tail = body.slice(index + probe.length).replace(/^[\s:：\-—]+/, "");
      // The panel repeats the question above the answer; prefer whatever follows
      // the echo, but never let a bare echo swallow the body above it.
      body = tail.trim().length >= 20 ? tail.trim() : body.trim();
    }
  }
  body = body
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !LEADING_NOISE.some((noise) => trimmed === noise || trimmed === `${noise}…`);
    })
    .join("\n");
  return body.trim();
}

/** A short reply that only hands the visitor off to a human carries no answer. */
function isHandoff(text) {
  const body = String(text || "").trim();
  if (!body || body.length > 200) return false;
  return HANDOFF_MARKERS.some((marker) => body.includes(marker));
}

function isCaptchaText(text) {
  const lowered = String(text || "").toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
}

function looksLikeLoginUrl(spec, url) {
  const lowered = String(url || "").toLowerCase();
  return spec.loginUrlMarkers.some((marker) => lowered.includes(marker));
}

function matchUrl(spec, question) {
  return spec.needsQuery ? spec.url.replace("{q}", encodeURIComponent(question)) : spec.url;
}

function failure(vendor, name, status, error) {
  return { ok: false, vendor, name, status, text: "", url: "", elapsedMs: 0, error: error || null };
}

function probeFromValue(value) {
  const bodyTail = typeof value.bodyTail === "string" ? value.bodyTail : "";
  const pageText = `${value.title || ""}\n${bodyTail}`.toLowerCase();
  return {
    hasBox: !!value.hasBox,
    panel: value.panel !== false,
    answer: typeof value.answer === "string" ? value.answer : "",
    busy: !!value.busy,
    login: !!value.login,
    captcha: isCaptchaText(pageText),
    url: typeof value.url === "string" ? value.url : "",
    bodyTail,
  };
}

async function readProbe(session, script) {
  const raw = await session.evaluateString(script);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return probeFromValue(value || {});
}

/**
 * Signs in with the saved account when the vendor walled the chat behind a
 * login form.
 *
 * Huawei keeps its session in memory only, so every fresh browser lands on the
 * SSO form even though the profile already holds the account. Returns true when
 * the form was submitted, which the caller follows with a reload.
 */
async function trySignIn(session, spec, profileRoot) {
  const account = specs.accounts(spec.key, profileRoot);
  if (!account || !account.username) return "no_account";
  let form;
  try {
    form = JSON.parse(await session.evaluateString(specs.signInFormScript()));
  } catch {
    return "no_form";
  }
  if (!form || !form.user || !form.pass) return "no_form";
  try {
    await session.evaluateString(specs.fillSignInScript(account.username, account.password));
  } catch {
    return "no_form";
  }
  await sleep(300);
  await clickCandidates(session, specs.SIGN_IN.submit);
  return "submitted";
}

/** Clicks only the first visible candidate; used for idempotent entry buttons. */
async function clickFirst(session, selectors) {
  if (!Array.isArray(selectors) || !selectors.length) return;
  let points;
  try {
    points = JSON.parse(await session.evaluateString(specs.pointsScript(selectors)));
  } catch {
    return;
  }
  if (!Array.isArray(points)) return;
  const point = points.find((entry) => Number.isFinite(Number(entry && entry.x)) && Number.isFinite(Number(entry && entry.y)));
  if (!point) return;
  const x = Number(point.x);
  const y = Number(point.y);
  try {
    await session.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await session.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } catch {
    // The page can navigate away mid-click.
  }
  await sleep(200);
}

/** Clicks every visible candidate with real mouse events. */
async function clickCandidates(session, selectors) {
  const script = specs.pointsScript(selectors);
  if (!script) return;
  let points;
  try {
    points = JSON.parse(await session.evaluateString(script));
  } catch {
    return;
  }
  if (!Array.isArray(points)) return;
  for (const point of points) {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    try {
      await session.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await session.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } catch {
      // A disappearing overlay is not fatal.
    }
    await sleep(250);
  }
  // Some overlays only close on their own click handler, which trusted mouse
  // events miss when the hit test lands on a covering layer.
  try {
    const jsScript = specs.jsClickScript(selectors);
    if (jsScript) await session.evaluateString(jsScript);
  } catch {
    // The page can navigate away mid-click.
  }
  await sleep(150);
}

async function runChatSession(spec, question, session, timeoutMs, profileRoot) {
  const deadline = Date.now() + timeoutMs;
  const probeScript = specs.probeScript(spec);
  await sleep(800);
  if (spec.initJs) {
    try {
      await session.evaluateString(spec.initJs);
    } catch {
      // A missing storage API only loses the flag.
    }
    // Feature flags are read while the page boots, so reload once set.
    await sleep(300);
    await session.navigate(matchUrl(spec, question));
    await sleep(800);
  }
  await clickCandidates(session, spec.dismiss);
  await clickCandidates(session, spec.click);

  let page = await readProbe(session, probeScript);
  const composerDeadline = Date.now() + Math.min(COMPOSER_TIMEOUT_MS, timeoutMs);
  let nextEntryAttempt = Date.now() + 4000;
  let nextSignInAttempt = 0;
  for (;;) {
    if (page && page.hasBox && page.panel) break;
    if (page && (page.login || looksLikeLoginUrl(spec, page.url))) {
      if (Date.now() >= nextSignInAttempt) {
        nextSignInAttempt = Date.now() + 3000;
        const attempt = await trySignIn(session, spec, profileRoot);
        if (attempt === "no_account") {
          return { status: STATUS.NEED_LOGIN, error: `${spec.name} requires a browser sign-in first` };
        }
        if (attempt === "submitted") {
          await sleep(2500);
          await session.navigate(matchUrl(spec, question));
          await sleep(1200);
          await clickCandidates(session, spec.dismiss);
          await clickCandidates(session, spec.click);
          page = await readProbe(session, probeScript);
          continue;
        }
      }
      // The sign-in form renders a moment after the redirect lands, so keep
      // polling for it until the deadline instead of failing on the first read.
      if (Date.now() >= composerDeadline) {
        return {
          status: STATUS.NEED_LOGIN,
          error: `${spec.name} requires a browser sign-in first (the login form never showed up)`,
        };
      }
      await sleep(POLL_INTERVAL_MS);
      page = await readProbe(session, probeScript);
      continue;
    }
    if (Date.now() >= nextEntryAttempt) {
      await clickCandidates(session, spec.dismiss);
      await clickCandidates(session, spec.click);
      nextEntryAttempt = Date.now() + 5000;
    }
    if (Date.now() >= composerDeadline) {
      const status = page && page.login ? STATUS.NEED_LOGIN : STATUS.SELECTOR;
      return { status, error: `${spec.name} composer did not appear (composer found: ${!!(page && page.hasBox)})` };
    }
    await sleep(POLL_INTERVAL_MS);
    page = await readProbe(session, probeScript);
  }

  const baseline = page ? page.answer : "";
  // Real mouse focus plus the browser input pipeline produce trusted key
  // events; framework apps ignore value assignments that come from scripts.
  await clickCandidates(session, spec.input);
  try {
    await session.call("Input.insertText", { text: question });
  } catch (error) {
    return { status: STATUS.SELECTOR, error: error instanceof Error ? error.message : String(error) };
  }
  await sleep(200);
  let typed = "";
  try {
    typed = await session.evaluateString(specs.valueScript(spec));
  } catch {
    typed = "";
  }
  if (!String(typed || "").trim()) {
    try {
      await session.evaluateString(specs.typeScript(spec, question));
    } catch (error) {
      return { status: STATUS.SELECTOR, error: error instanceof Error ? error.message : String(error) };
    }
  }
  await sleep(300);

  // Trusted key submission first: several panels render the user bubble from a
  // synthetic click but only start generating on a real Enter.
  if (spec.pressEnter) {
    try {
      await session.pressKey("Enter", "Enter", 13);
    } catch (error) {
      return { status: STATUS.SELECTOR, error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(1500);
  }
  if (spec.sendClick.length) {
    const after = await readProbe(session, probeScript);
    if (!after || after.answer === baseline) {
      await clickCandidates(session, spec.sendClick);
    }
  }

  let lastText = "";
  let stableRounds = 0;
  let lastUrl = "";
  let lastState = "no probe yet";
  let nextDismissAttempt = Date.now() + 3000;
  for (;;) {
    if (Date.now() >= deadline) {
      return { status: STATUS.TIMEOUT, error: `${spec.name} did not answer in time (${lastState})` };
    }
    // Privacy cards and cookie banners can appear mid-answer and would
    // otherwise swallow the stream.
    if (Date.now() >= nextDismissAttempt) {
      await clickCandidates(session, spec.dismiss);
      nextDismissAttempt = Date.now() + 3000;
    }
    await sleep(POLL_INTERVAL_MS);
    const current = await readProbe(session, probeScript);
    if (!current) continue;
    lastState = `answer ${current.answer.length} chars "${current.answer.slice(0, 120)}", busy ${current.busy}, url ${current.url}, page "${current.bodyTail.slice(0, 300)}"`;
    if (!lastUrl) lastUrl = current.url;
    // A sign-in wall and a verification challenge only block the flow while the
    // composer is unavailable; both phrases also appear in ordinary page
    // chrome, so a visible composer always wins.
    if (!current.hasBox && current.login) {
      if ((await trySignIn(session, spec, profileRoot)) === "submitted") {
        await sleep(2500);
        await session.navigate(matchUrl(spec, question));
        await sleep(1500);
        const refreshed = await readProbe(session, probeScript);
        if (refreshed && refreshed.hasBox) {
          page = refreshed;
          break;
        }
      }
      return { status: STATUS.NEED_LOGIN, error: `${spec.name} requires a browser sign-in first` };
    }
    if (!current.hasBox && current.captcha) {
      return { status: STATUS.CAPTCHA, error: `${spec.name} showed a verification challenge` };
    }
    const text = cleanAnswer(current.answer, question);
    if (!text.trim() || text.trim() === String(baseline || "").trim()) continue;
    if (text === lastText) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastText = text;
    }
    const longEnough = lastText.length >= MIN_ANSWER_CHARS;
    const done = spec.doneMarker ? current.answer.includes(spec.doneMarker) : false;
    // Sites pause mid-stream; stopping on a flat character count cut answers in
    // the middle of a word. Only settle when the text also ends at a boundary.
    const atBoundary = ANSWER_BOUNDARY.test(lastText.trim());
    // A streaming indicator is authoritative: never stop while it is up.
    if (longEnough && !current.busy && (done || (stableRounds >= 3 && atBoundary) || stableRounds >= 8)) break;
  }

  if (!lastText.trim()) {
    return { status: STATUS.TIMEOUT, error: `${spec.name} returned no text` };
  }
  if (isHandoff(lastText)) {
    return { status: STATUS.NO_ANSWER, text: "", error: `${spec.name} answered with a hand-off notice only`, url: lastUrl };
  }
  return { status: STATUS.OK, text: lastText, url: lastUrl };
}

async function waitForQueryPage(spec, session, timeoutMs, profileRoot) {
  const deadline = Date.now() + timeoutMs;
  const probeScript = specs.probeScript(spec);
  let signInAttempted = false;
  for (;;) {
    if (Date.now() >= deadline) {
      return { status: STATUS.TIMEOUT, error: `${spec.name} returned no answer block` };
    }
    const current = await readProbe(session, probeScript);
    if (current) {
      if (!current.hasBox && current.login) {
        if (!signInAttempted) {
          signInAttempted = true;
          if ((await trySignIn(session, spec, profileRoot)) === "submitted") {
            await sleep(2500);
            await session.navigate(matchUrl(spec, "Sign in to see the AI answer"));
            await sleep(1500);
            continue;
          }
        }
        return { status: STATUS.NEED_LOGIN, error: `${spec.name} requires a browser sign-in first` };
      }
      if (!current.hasBox && current.captcha) {
        return { status: STATUS.CAPTCHA, error: `${spec.name} showed a verification challenge` };
      }
      const text = current.answer.trim();
      const done = spec.doneMarker
        ? current.answer.includes(spec.doneMarker) || current.bodyTail.includes(spec.doneMarker)
        : false;
      if (done && text.length >= MIN_ANSWER_CHARS) {
        return { status: STATUS.OK, text, url: current.url };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Asks one vendor assistant and resolves to its answer.
 *
 * @param {string} vendor
 * @param {string} question
 * @param {{headless?: boolean, timeoutMs?: number, profileRoot?: string, browserPath?: string|null}} [options]
 */
async function ask(vendor, question, options = {}) {
  const started = Date.now();
  const spec = specs.resolve(vendor);
  if (!spec) {
    return failure(String(vendor || ""), String(vendor || ""), STATUS.NO_ASSISTANT, "unknown vendor");
  }
  const clean = sanitizeQuestion(question);
  if (!clean) {
    return failure(spec.key, spec.name, STATUS.NO_ASSISTANT, "empty question");
  }
  const profileRoot = options.profileRoot || specs.defaultProfileRoot();
  const profile = specs.profileDir(spec.key, profileRoot);
  const timeoutMs = Math.max(15000, Math.min(600000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));

  // A sign-in window left open by the login flow owns the profile directory.
  await closeLingeringLogin(spec.key);

  let launched;
  try {
    launched = await launchBrowser({
      profileDir: profile,
      headless: options.headless !== false,
      browserPath: options.browserPath || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /no Microsoft Edge or Google Chrome/.test(message) ? STATUS.DISABLED : STATUS.BLOCKED;
    return failure(spec.key, spec.name, status, message);
  }

  const result = { ok: false, vendor: spec.key, name: spec.name, status: STATUS.ERROR, text: "", url: "", error: null };
  try {
    const session = await CdpSession.connect(launched.webSocketUrl, 20000);
    let outcome;
    try {
      await session.call("Page.enable", {});
      // Desktop viewport: the vendor sites swap in a mobile AI drawer when the
      // window is narrow, and that drawer exposes a different entry element.
      await session
        .call("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        })
        .catch(() => {});
      await session.navigate(matchUrl(spec, clean));
      outcome = spec.needsQuery
        ? await waitForQueryPage(spec, session, timeoutMs, profileRoot)
        : await runChatSession(spec, clean, session, timeoutMs, profileRoot);
      await session.close();
    } finally {
      try {
        session.socket.close();
      } catch {
        // Already closed.
      }
    }
    result.status = outcome.status;
    result.text = outcome.status === STATUS.OK ? outcome.text || "" : outcome.text || "";
    result.url = outcome.url || "";
    result.error = outcome.error || null;
    result.ok = outcome.status === STATUS.OK;
    if (result.ok) specs.markLoggedIn(spec.key, profileRoot);
  } catch (error) {
    result.status = STATUS.ERROR;
    result.error = error instanceof CdpError ? error.message : error instanceof Error ? error.message : String(error);
  } finally {
    try {
      launched.child.kill();
    } catch {
      // Already gone.
    }
  }
  result.elapsedMs = Date.now() - started;
  result.code = STATUS_CODES[result.status] || 1;
  return result;
}

/**
 * Opens a visible browser so the user can sign in once. Resolves when the
 * composer shows up (or the caller cancels), and writes the login marker.
 */
async function openLogin(vendor, options = {}) {
  const spec = specs.resolve(vendor);
  if (!spec) {
    return failure(String(vendor || ""), String(vendor || ""), STATUS.NO_ASSISTANT, "unknown vendor");
  }
  const profileRoot = options.profileRoot || specs.defaultProfileRoot();
  const profile = specs.profileDir(spec.key, profileRoot);
  const timeoutMs = Math.max(30000, Math.min(1800000, Number(options.timeoutMs) || 600000));
  await closeLingeringLogin(spec.key);
  let keepOpen = false;
  const alreadyLoggedIn = specs.loginState(spec.key, profileRoot) === "logged";
  let launched;
  try {
    launched = await launchBrowser({
      profileDir: profile,
      headless: options.headless === true,
      browserPath: options.browserPath || null,
    });
  } catch (error) {
    return failure(spec.key, spec.name, STATUS.BLOCKED, error instanceof Error ? error.message : String(error));
  }
  const started = Date.now();
  try {
    const session = await CdpSession.connect(launched.webSocketUrl, 20000);
    try {
      await session.call("Page.enable", {});
      await session.navigate(matchUrl(spec, options.question || "你好"));
      const probeScript = specs.probeScript(spec);
      let probeErrors = 0;
      let signInTries = 0;
      let nextSignInAt = 0;
      let nextEntryAt = 0;
      // Only an actual credential submission (or a profile that was already
      // signed in) proves a sign-in: guest composers and SSO redirects both
      // look like a ready page otherwise.
      let signInSubmitted = false;
      while (Date.now() - started < timeoutMs) {
        let page = null;
        try {
          page = await readProbe(session, probeScript);
          probeErrors = 0;
        } catch {
          // Closing the sign-in window ends the wait instead of looping for
          // the whole timeout.
          probeErrors += 1;
          if (probeErrors >= 3) {
            return failure(spec.key, spec.name, STATUS.NEED_LOGIN, "the sign-in window was closed");
          }
          await sleep(1000);
          continue;
        }
        // The composer is the only dependable "signed in" signal: the SSO
        // pages do not carry the walled markers, and a stale marker keeps the
        // old loop spinning long after the user finished signing in.
        const onSignInPage = looksLikeLoginUrl(spec, page ? page.url : "");
        if (page && page.hasBox && page.panel && !onSignInPage) {
          const confirmed = !page.login && (signInSubmitted || alreadyLoggedIn);
          if (confirmed) specs.markLoggedIn(spec.key, profileRoot);
          // Leaving the window open lets the user finish signing in on pages
          // that show their composer before any sign-in happens.
          if (!confirmed && options.headless !== true) {
            keepOpen = true;
            lingeringLogins.set(spec.key, { child: launched.child, session });
          }
          return {
            ok: true,
            vendor: spec.key,
            name: spec.name,
            status: STATUS.OK,
            text: "",
            url: page.url,
            elapsedMs: Date.now() - started,
            logged: confirmed,
            error: null,
          };
        }
        // Sign in with the saved account so the button is a single step.
        if (signInTries < 4 && Date.now() >= nextSignInAt && (onSignInPage || (page && page.login))) {
          signInTries += 1;
          nextSignInAt = Date.now() + 8000;
          const outcome = await trySignIn(session, spec, profileRoot);
          if (outcome === "submitted") {
            signInSubmitted = true;
            await sleep(3000);
            continue;
          }
        }
        // Several landing pages keep the composer behind an entry button (for
        // example "新建对话"), so press it the way the chat driver does.
        if (page && !page.hasBox && !onSignInPage && Date.now() >= nextEntryAt) {
          nextEntryAt = Date.now() + 5000;
          await clickFirst(session, spec.click);
        }
        await sleep(1000);
      }
      return failure(spec.key, spec.name, STATUS.NEED_LOGIN, `no sign-in detected within ${Math.round(timeoutMs / 1000)}s`);
    } finally {
      // A window left open for the user keeps its session so a later call can
      // close the browser gracefully; killing the launcher alone leaves the
      // real browser holding the profile directory.
      if (!keepOpen) {
        try {
          await session.close();
        } catch {
          // Already closed.
        }
        try {
          session.socket.close();
        } catch {
          // Already closed.
        }
      }
    }
  } finally {
    if (!keepOpen) {
      try {
        launched.child.kill();
      } catch {
        // Already gone.
      }
    }
  }
}

/** Reports the vendor list, login state and browser availability. */
function status(options = {}) {
  const profileRoot = options.profileRoot || specs.defaultProfileRoot();
  const browser = findBrowser(options.browserPath || null);
  return {
    ok: true,
    profileRoot,
    browser: browser ? { path: browser, found: true } : { path: null, found: false },
    vendors: specs.VENDORS.map((spec) => {
      const state = specs.loginState(spec.key, profileRoot);
      return { key: spec.key, name: spec.name, url: spec.url, login: state.state, dir: state.dir };
    }),
  };
}

module.exports = {
  STATUS,
  STATUS_CODES,
  ask,
  cleanAnswer,
  isHandoff,
  isCaptchaText,
  openLogin,
  sanitizeQuestion,
  status,
};

