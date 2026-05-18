const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const TEMP_ROOT = path.join(__dirname, ".tmp-session-logs-bridge-tests");

function loadBridgeWithDialog(dialogMock) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return { dialog: dialogMock };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const bridgePath = require.resolve("./sessionLogsBridge.cjs");
    delete require.cache[bridgePath];
    return require("./sessionLogsBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

test("manual export default filename preserves valid Unicode host labels and replaces dangerous characters", async () => {
  let defaultPath = "";
  const dialogMock = {
    showSaveDialog: async (options) => {
      defaultPath = options.defaultPath;
      return { canceled: true };
    },
  };
  const { exportSessionLog } = loadBridgeWithDialog(dialogMock);

  const result = await exportSessionLog(null, {
    terminalData: "hello\n",
    hostLabel: "生产/服务器:东京*?<>|\0",
    hostname: "fallback.example",
    startTime: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    format: "txt",
  });

  assert.deepEqual(result, { success: false, canceled: true });
  assert.equal(defaultPath, "生产_服务器_东京_______2026-01-02T03-04-05.txt");
  assert.equal(defaultPath.includes("/"), false);
  assert.equal(defaultPath.includes(":"), false);
  assert.equal(defaultPath.includes("\0"), false);
});

test("safe path segments replace invisible control characters and protected names", () => {
  const { safePathSegment } = loadBridgeWithDialog({});

  assert.equal(safePathSegment("\t生产服务器\n", "fallback"), "_生产服务器_");
  assert.equal(safePathSegment("生产\u0085服务器\u009b", "fallback"), "生产_服务器_");
  assert.equal(safePathSegment("../name", "fallback"), ".._name");
  assert.equal(safePathSegment("CON", "fallback"), "CON_");
  assert.equal(safePathSegment("COM¹", "fallback"), "COM¹_");
  assert.equal(safePathSegment("LPT².txt", "fallback"), "LPT².txt_");
  assert.equal(safePathSegment("prod.", "fallback"), "prod_");
  assert.equal(safePathSegment("prod..", "fallback"), "prod__");
});

test("auto-save host directory preserves valid Unicode labels and replaces path-unsafe characters", async () => {
  const directory = path.join(TEMP_ROOT, `auto-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { autoSaveSessionLog } = loadBridgeWithDialog({});

  try {
    const result = await autoSaveSessionLog(null, {
      terminalData: "hello\n",
      hostLabel: "生产/服务器:东京*?<>|\0",
      hostname: "fallback.example",
      hostId: "host-id",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      format: "raw",
      directory,
    });

    assert.equal(result.success, true);
    assert.equal(path.basename(path.dirname(result.filePath)), "生产_服务器_东京______");
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "hello\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("auto-save host directory falls back when the sanitized host label is empty", async () => {
  const directory = path.join(TEMP_ROOT, `auto-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { autoSaveSessionLog } = loadBridgeWithDialog({});

  try {
    const result = await autoSaveSessionLog(null, {
      terminalData: "hello\n",
      hostLabel: "   ",
      hostname: "",
      hostId: "",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      format: "txt",
      directory,
    });

    assert.equal(result.success, true);
    assert.equal(path.basename(path.dirname(result.filePath)), "unknown");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
