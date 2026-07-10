const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { VALID_VARIANTS } = require("../electron/bridges/appIconManager.cjs");

const APP_ICON_VARIANTS = [...VALID_VARIANTS];

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function readRgbaPngAlphaBounds(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  let offset = 8;
  let width;
  let height;
  const imageData = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual(
        [...data.subarray(8, 13)],
        [8, 6, 0, 0, 0],
        `${file} must be an 8-bit, non-interlaced RGBA PNG`,
      );
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  assert.equal(width, 1024, `${file} must keep the 1024px app-icon canvas`);
  assert.equal(height, 1024, `${file} must keep the 1024px app-icon canvas`);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(imageData));
  assert.equal(raw.length, (stride + 1) * height, `${file} has unexpected PNG data`);

  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset];
    sourceOffset += 1;
    const current = Buffer.from(raw.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;

    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      else assert.fail(`${file} uses unsupported PNG filter ${filter}`);
      current[index] = (current[index] + predictor) & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      if (current[x * bytesPerPixel + 3] <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    previous = current;
  }

  return { minX, minY, maxX, maxY };
}

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

test("macOS keeps the packaged icon unchanged and sizes only runtime Dock icons", () => {
  const projectRoot = path.join(__dirname, "..");
  const config = require("../electron-builder.config.cjs");
  assert.equal(config.mac?.icon ?? config.icon, "public/icon.png");
  assert.deepEqual(
    readRgbaPngAlphaBounds(path.join(projectRoot, "public/icon.png")),
    { minX: 61, minY: 61, maxX: 962, maxY: 962 },
    "The packaged icon already looks correct when Netcatty is not running",
  );

  for (const variant of APP_ICON_VARIANTS) {
    const iconFile = path.join(
      projectRoot,
      "public/icons/variants/macos",
      `${variant}.png`,
    );
    assert.deepEqual(
      readRgbaPngAlphaBounds(iconFile),
      { minX: 100, minY: 100, maxX: 923, maxY: 923 },
      `${path.relative(projectRoot, iconFile)} must render on the 824px macOS icon grid`,
    );
  }
});

test("non-macOS runtime icons preserve their existing desktop sizing", () => {
  const projectRoot = path.join(__dirname, "..");
  assert.deepEqual(
    readRgbaPngAlphaBounds(path.join(projectRoot, "public/icon-win.png")),
    { minX: 0, minY: 0, maxX: 1023, maxY: 1023 },
    "The packaged Windows icon must remain full bleed",
  );

  for (const variant of APP_ICON_VARIANTS) {
    const iconFile = path.join(projectRoot, "public/icons/variants", `${variant}.png`);
    assert.deepEqual(
      readRgbaPngAlphaBounds(iconFile),
      { minX: 61, minY: 61, maxX: 962, maxY: 962 },
      `${path.relative(projectRoot, iconFile)} must keep the existing desktop runtime size`,
    );
  }
});
