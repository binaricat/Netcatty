const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("main process leaves macOS Dock icon to the packaged app bundle", () => {
  const mainProcess = fs.readFileSync(
    path.join(__dirname, "../electron/main.cjs"),
    "utf8",
  );

  assert.equal(
    mainProcess.includes("app.dock.setIcon"),
    false,
    "Do not override the macOS Dock icon at runtime; it can render at a different size than the bundled .icns icon.",
  );
});
