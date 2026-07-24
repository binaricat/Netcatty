"use strict";

if (!process.versions.electron) {
  const test = require("node:test");
  test("xterm WebGL atlas stays within renderer texture capacity", {
    skip: "run with Electron so WebGL is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const electron = require("electron");

  const appRoot = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-webgl-overflow-"));
  electron.app.setPath("userData", userData);
  electron.app.commandLine.appendSwitch("use-angle", "swiftshader");
  electron.app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  electron.app.on("window-all-closed", () => {});

  const cleanup = (exitCode) => {
    fs.rmSync(userData, { recursive: true, force: true });
    electron.app.exit(exitCode);
  };

  void electron.app.whenReady().then(async () => {
    const window = new electron.BrowserWindow({
      show: false,
      width: 900,
      height: 560,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body,#terminal{width:800px;height:480px;margin:0}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const webglPath = require.resolve("@xterm/addon-webgl", { paths: [appRoot] });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const { WebglAddon } = require(${JSON.stringify(webglPath)});
      const container = document.getElementById("terminal");
      const errors = [];
      window.addEventListener("error", event => {
        errors.push(String(event.error?.stack || event.message || event.error));
        event.preventDefault();
      });
      window.addEventListener("unhandledrejection", event => {
        errors.push(String(event.reason?.stack || event.reason));
        event.preventDefault();
      });

      const bootstrap = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      bootstrap.open(container);
      const bootstrapAddon = new WebglAddon({ preserveDrawingBuffer: true });
      bootstrap.loadAddon(bootstrapAddon);
      await new Promise(resolve => setTimeout(resolve, 50));
      const bootstrapAtlas = bootstrap._core?._renderService?._renderer?.value?._charAtlas;
      if (!bootstrapAtlas) throw new Error("WebGL texture atlas was not created");
      bootstrapAtlas.constructor.maxAtlasPages = 4;
      bootstrapAtlas.constructor.maxTextureSize = 512;
      bootstrap.dispose();
      container.replaceChildren();

      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      term.open(container);
      const addon = new WebglAddon({ preserveDrawingBuffer: true });
      let removals = 0;
      addon.onRemoveTextureAtlasCanvas(() => { removals += 1; });
      term.loadAddon(addon);
      await new Promise(resolve => setTimeout(resolve, 50));

      const renderer = term._core?._renderService?._renderer?.value;
      const atlas = renderer?._charAtlas;
      const glyphRenderer = renderer?._glyphRenderer?.value;
      if (!atlas || !glyphRenderer || renderer !== addon._renderer) {
        throw new Error("WebGL renderer internals are unavailable");
      }

      const generateUniqueGlyphFlood = (count, offset) => {
        const base = 0x4E00;
        const range = 0x9FFF - base;
        const perRow = 40;
        let output = "";
        for (let index = 0; index < count; index += 1) {
          output += String.fromCodePoint(base + ((offset + index) % range));
          if ((index + 1) % perRow === 0 && index + 1 < count) output += "\\r\\n";
        }
        return output;
      };

      const write = data => new Promise(resolve => term.write(data, resolve));
      const glyphsPerChunk = 23 * 40 - 1;
      let peakPages = atlas.pages.length;
      for (let chunk = 0; chunk < 32; chunk += 1) {
        await write("\\x1b[H\\x1b[2J" + generateUniqueGlyphFlood(glyphsPerChunk, chunk * glyphsPerChunk));
        await new Promise(resolve => setTimeout(resolve, 35));
        peakPages = Math.max(peakPages, atlas.pages.length);
        if (errors.length > 0 || atlas.pages.length > glyphRenderer._atlasTextures.length) break;
      }

      const state = {
        errors,
        pages: atlas.pages.length,
        peakPages,
        textures: glyphRenderer._atlasTextures.length,
        removals,
      };
      term.dispose();
      return state;
    })()`);

    assert.equal(result.textures, 4, `expected a deterministic 4-texture test cap: ${JSON.stringify(result)}`);
    assert.equal(result.errors.length, 0, `WebGL rendering threw after atlas growth: ${result.errors[0] || ""}`);
    assert.ok(
      result.peakPages <= result.textures,
      `atlas grew beyond renderer texture capacity: ${JSON.stringify(result)}`,
    );
    assert.ok(result.removals > 0, `atlas never exercised its capacity recovery: ${JSON.stringify(result)}`);
    process.stdout.write(`XTERM_WEBGL_ATLAS_OVERFLOW_OK ${JSON.stringify(result)}\n`);
    window.destroy();
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
