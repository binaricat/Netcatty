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

      const captureCellSignatures = columns => {
        const gl = renderer._gl;
        const canvas = renderer._canvas;
        const cell = renderer.dimensions?.device?.cell;
        if (!gl || !canvas || !cell?.width || !cell?.height) {
          throw new Error("WebGL canvas dimensions are unavailable");
        }
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const grid = 4;
        return columns.map(column => {
          const sums = new Array(grid * grid * 4).fill(0);
          const counts = new Array(grid * grid).fill(0);
          const startX = Math.max(0, Math.floor(column * cell.width));
          const endX = Math.min(canvas.width, Math.ceil((column + 1) * cell.width));
          const startY = 0;
          const endY = Math.min(canvas.height, Math.ceil(cell.height));
          for (let y = startY; y < endY; y += 1) {
            const gridY = Math.min(grid - 1, Math.floor((y / cell.height) * grid));
            const sourceY = canvas.height - y - 1;
            for (let x = startX; x < endX; x += 1) {
              const gridX = Math.min(
                grid - 1,
                Math.floor(((x - column * cell.width) / cell.width) * grid),
              );
              const bucket = gridY * grid + gridX;
              const pixel = (sourceY * canvas.width + x) * 4;
              for (let channel = 0; channel < 4; channel += 1) {
                sums[bucket * 4 + channel] += pixels[pixel + channel];
              }
              counts[bucket] += 1;
            }
          }
          return sums.map((sum, index) => {
            const count = counts[Math.floor(index / 4)];
            return count > 0 ? sum / count : 0;
          });
        });
      };
      const signatureDiff = (left, right) => {
        let difference = 0;
        for (let index = 0; index < left.length; index += 1) {
          difference = Math.max(difference, Math.abs(left[index] - right[index]));
        }
        return difference;
      };
      const maxSignatureDiff = (left, right) => Math.max(
        ...left.map((signature, index) => signatureDiff(signature, right[index])),
      );
      const writeAndWaitForRender = (data, label) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          disposable.dispose();
          reject(new Error("timed out waiting for terminal render: " + label));
        }, 10000);
        const disposable = term.onRender(() => {
          clearTimeout(timeout);
          disposable.dispose();
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        term.write(data);
      });
      const marker = "AFTER_EVICTION_0123456789";
      const markerColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      await writeAndWaitForRender(
        "\\x1b[H\\x1b[2J\\x1b[97m" + marker + "\\x1b[0m",
        "initial marker",
      );
      const markerReference = captureCellSignatures(markerColumns);

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

      const glyphsPerChunk = 23 * 40 - 1;
      let peakPages = atlas.pages.length;
      for (let chunk = 0; chunk < 32; chunk += 1) {
        await writeAndWaitForRender(
          "\\x1b[H\\x1b[2J" + generateUniqueGlyphFlood(glyphsPerChunk, chunk * glyphsPerChunk),
          "normal atlas flood " + chunk,
        );
        peakPages = Math.max(peakPages, atlas.pages.length);
        if (errors.length > 0 || atlas.pages.length > glyphRenderer._atlasTextures.length) break;
      }

      await writeAndWaitForRender(
        "\\x1b[H\\x1b[2J\\x1b[97m" + marker + "\\x1b[0m",
        "post-eviction marker",
      );
      const markerAfterEviction = captureCellSignatures(markerColumns);
      const markerPixelDiff = maxSignatureDiff(markerReference, markerAfterEviction);
      const normalPages = atlas.pages.length;
      const normalRemovals = removals;

      await writeAndWaitForRender("\\x1b[H\\x1b[2J", "wide-glyph blank reference");
      const wideColumns = [0, 7, 15, 23, 31];
      const blankSignatures = captureCellSignatures(wideColumns);
      const cellWidth = renderer.dimensions.device.cell.width;
      const joinedLength = Math.min(term.cols - 1, Math.ceil(atlas._textureSize / cellWidth) + 32);
      if (joinedLength * cellWidth <= atlas._textureSize) {
        throw new Error("joined glyph is not wider than a normal atlas page");
      }
      const wideMarker = "W".repeat(joinedLength);
      term.registerCharacterJoiner(text => text.startsWith(wideMarker) ? [[0, joinedLength]] : []);
      await writeAndWaitForRender("\\x1b[H" + wideMarker, "oversized glyph");
      const wideSignatures = captureCellSignatures(wideColumns);
      const minimumWidePixelDiff = Math.min(
        ...wideSignatures.map(
          (signature, index) => signatureDiff(signature, blankSignatures[index]),
        ),
      );

      const state = {
        errors,
        pages: normalPages,
        peakPages,
        textures: glyphRenderer._atlasTextures.length,
        removals,
        normalRemovals,
        markerPixelDiff,
        oversizedPages: atlas.pages.length,
        oversizedPageCreated: !!atlas._overflowSizePage,
        oversizedRemovals: removals - normalRemovals,
        minimumWidePixelDiff,
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
    assert.ok(
      result.normalRemovals > 0,
      `normal atlas pages never exercised capacity recovery: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.markerPixelDiff <= 14,
      `rendered text changed after atlas eviction: ${JSON.stringify(result)}`,
    );
    assert.equal(
      result.pages,
      result.textures,
      `normal atlas pages did not reach texture capacity: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.oversizedPageCreated,
      `oversized glyph did not use its dedicated atlas page: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.oversizedPages <= result.textures,
      `oversized glyph exceeded texture capacity: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.oversizedRemovals > 0,
      `oversized glyph did not evict full atlas pages: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.minimumWidePixelDiff > 14,
      `every sampled part of the oversized glyph must render visible pixels: ${JSON.stringify(result)}`,
    );
    process.stdout.write(`XTERM_WEBGL_ATLAS_OVERFLOW_OK ${JSON.stringify(result)}\n`);
    window.destroy();
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
