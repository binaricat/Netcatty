"use strict";

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * The browser is a Chromium-family binary (Edge or Chrome) started with a
 * persistent profile and an ephemeral debugging port. Only the few domains the
 * vendor driver needs are implemented: page navigation, runtime evaluation and
 * input dispatch.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const POLL_INTERVAL_MS = 250;
const LAUNCH_TIMEOUT_MS = 20000;

class CdpError extends Error {
  constructor(message) {
    super(message);
    this.name = "CdpError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Candidate browser binaries, most preferred first. */
function browserCandidates() {
  const out = [];
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  if (process.platform === "win32") {
    for (const base of [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const name of ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"]) {
      for (const base of ["/usr/bin", "/usr/local/bin", "/snap/bin"]) {
        push(path.join(base, name));
      }
    }
  }
  return out;
}

function findBrowser(explicitPath) {
  if (explicitPath) {
    try {
      if (fs.statSync(explicitPath).isFile()) return explicitPath;
    } catch {
      // Fall through to auto-detection.
    }
  }
  return browserCandidates().find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function readActivePort(profileDir) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const raw = fs.readFileSync(file, "utf8");
  const port = Number.parseInt(raw.split(/\r?\n/)[0], 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new CdpError("DevToolsActivePort does not contain a port");
  }
  return port;
}

function httpGet(port, requestPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: requestPath, timeout: timeoutMs, headers: { Host: `127.0.0.1:${port}` } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new CdpError(`DevTools HTTP request timed out (${requestPath})`)));
    request.on("error", reject);
  });
}

async function firstPageTarget(port) {
  const response = await httpGet(port, "/json/list");
  if (response.status !== 200) {
    throw new CdpError(`DevTools endpoint returned HTTP ${response.status}`);
  }
  let targets;
  try {
    targets = JSON.parse(response.body);
  } catch {
    throw new CdpError("DevTools endpoint returned invalid JSON");
  }
  const page = Array.isArray(targets) ? targets.find((target) => target.type === "page") : null;
  if (!page || !page.webSocketDebuggerUrl) {
    throw new CdpError("no page target exposed by the DevTools endpoint");
  }
  return page.webSocketDebuggerUrl;
}

/**
 * Clears the "previous session crashed" marker Chromium keeps in the profile.
 * We terminate login windows ourselves (profile recycling), and without this
 * Edge greets the user with a "restore pages" bubble on top of the sign-in page.
 */
function clearCrashMarker(profileDir) {
  const prefsFile = path.join(profileDir, "Default", "Preferences");
  let raw;
  try {
    raw = fs.readFileSync(prefsFile, "utf8");
  } catch {
    return;
  }
  let prefs;
  try {
    prefs = JSON.parse(raw);
  } catch {
    return;
  }
  const profile = prefs.profile;
  if (!profile || typeof profile !== "object") return;
  if (profile.exit_type === "Normal" && profile.exited_cleanly === true) return;
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  try {
    fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  } catch {
    // Read-only profile: the launch flags still suppress the bubble.
  }
}

/**
 * Starts the browser and waits until it exposes a DevTools endpoint.
 * Returns the child process and the page WebSocket URL.
 */
async function launchBrowser({ profileDir, headless = true, browserPath = null }) {
  const browser = findBrowser(browserPath);
  if (!browser) {
    throw new CdpError("no Microsoft Edge or Google Chrome installation found");
  }
  fs.mkdirSync(profileDir, { recursive: true });
  clearCrashMarker(profileDir);
  try {
    fs.unlinkSync(path.join(profileDir, "DevToolsActivePort"));
  } catch {
    // No stale endpoint file.
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // We sometimes terminate a login window ourselves (profile recycling), which
    // leaves Edge convinced the last session crashed and pops a "restore pages"
    // bubble over the sign-in page the user is supposed to use.
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    // The vendor widgets are laid out differently below the desktop
    // breakpoint (the AI entry becomes a mobile drawer), so keep a desktop
    // window even when running headless.
    "--window-size=1440,900",
    "--disable-features=Translate,MediaRouter",
    "--disable-blink-features=AutomationControlled",
  ];
  if (headless) args.push("--headless=new", "--disable-gpu");
  args.push("about:blank");

  const child = spawn(browser, args, { stdio: "ignore", windowsHide: true });
  const started = Date.now();
  let lastError = "DevToolsActivePort was not written";
  while (Date.now() - started < LAUNCH_TIMEOUT_MS) {
    try {
      const port = readActivePort(profileDir);
      const webSocketUrl = await firstPageTarget(port);
      return { child, browser, port, webSocketUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.exitCode !== null) {
      throw new CdpError(`browser exited while starting (code ${child.exitCode}): ${lastError}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  throw new CdpError(
    `browser did not expose a DevTools endpoint within ${LAUNCH_TIMEOUT_MS / 1000}s (${lastError}; is another window using this profile?)`,
  );
}

class CdpSession {
  constructor(socket, callTimeoutMs = 30000) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.callTimeoutMs = callTimeoutMs;
    this.closed = false;
  }

  static async connect(webSocketUrl, callTimeoutMs = 30000) {
    const WebSocketImpl = globalThis.WebSocket;
    if (typeof WebSocketImpl !== "function") {
      throw new CdpError("this runtime does not provide a WebSocket client");
    }
    const socket = new WebSocketImpl(webSocketUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new CdpError("could not open the DevTools WebSocket"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    const session = new CdpSession(socket, callTimeoutMs);
    socket.addEventListener("message", (event) => session.onMessage(event.data));
    socket.addEventListener("close", () => session.onClose());
    return session;
  }

  onClose() {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError("DevTools connection closed"));
    }
    this.pending.clear();
  }

  onMessage(raw) {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new CdpError(message.error.message || "DevTools command failed"));
    } else {
      entry.resolve(message.result || {});
    }
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new CdpError("DevTools connection closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`DevTools command timed out: ${method}`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new CdpError(String(error)));
      }
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new CdpError("page script failed");
    }
    return result.result ? result.result.value : undefined;
  }

  async evaluateString(expression) {
    const value = await this.evaluate(expression);
    if (value == null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  navigate(url) {
    return this.call("Page.navigate", { url });
  }

  /**
   * Presses a single key through the input domain.
   *
   * rawKeyDown alone never produces a keypress, and some frameworks only react
   * to the char event, so all three events are sent.
   */
  async pressKey(key, code, virtualKey) {
    for (const type of ["rawKeyDown", "char", "keyUp"]) {
      const params = {
        type,
        key,
        code,
        windowsVirtualKeyCode: virtualKey,
        nativeVirtualKeyCode: virtualKey,
      };
      if (type === "char") params.text = key === "Enter" ? "\r" : "";
      await this.call("Input.dispatchKeyEvent", params);
    }
  }

  clickAt(x, y) {
    return this.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    }).then(() =>
      this.call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      }),
    );
  }

  async close() {
    try {
      await this.call("Browser.close", {});
    } catch {
      // The browser may already be closing.
    }
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

module.exports = {
  CdpError,
  CdpSession,
  LAUNCH_TIMEOUT_MS,
  browserCandidates,
  findBrowser,
  firstPageTarget,
  launchBrowser,
  readActivePort,
  sleep,
};
