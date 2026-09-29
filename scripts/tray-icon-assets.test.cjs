const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

// Brand sky blue sampled from public/icons/variants/bright.png - the same
// color the tray glyphs are recolored with by scripts/generate-tray-ico.py.
const BRAND_RGB = [14, 165, 233];

function readRgbaPng(png, label) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${label} is a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // 8-bit, color type 6 (RGBA), non-interlaced
      assert.deepEqual(
        [...data.subarray(8, 13)],
        [8, 6, 0, 0, 0],
        `${label} must be an 8-bit RGBA PNG`,
      );
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  return { width, height, idat };
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

// Inflate and unfilter full RGBA pixel rows so the color/alpha assertions can
// work on real pixel values (Pillow writes filters 0-4).
function readPngPixels(png, label) {
  const { width, height, idat } = readRgbaPng(png, label);
  const zlib = require("node:zlib");
  const stride = width * 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * height, `${label} has unexpected PNG data`);
  const pixels = [];
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset];
    sourceOffset += 1;
    const current = Buffer.from(raw.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 4 ? current[index - 4] : 0;
      const up = previous[index];
      const upperLeft = index >= 4 ? previous[index - 4] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      else assert.fail(`${label} uses unsupported PNG filter ${filter}`);
      current[index] = (current[index] + predictor) & 0xff;
    }
    pixels.push(current);
    previous = current;
  }
  return { width, height, pixels };
}

function assertBrandGlyph(png, expectedSize, label, { colorTolerance = 3, marginFraction = 0.15 } = {}) {
  const image = readPngPixels(png, label);
  assert.equal(image.width, expectedSize, `${label} width`);
  assert.equal(image.height, expectedSize, `${label} height`);

  // Corners must be transparent: the tray asset is a full-bleed glyph, not
  // the rounded-square app chip that looked small and dark in the tray.
  for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
    assert.equal(
      image.pixels[y][x * 4 + 3],
      0,
      `${label} corner (${x},${y}) must be transparent`,
    );
  }

  // Glyph must span (nearly) the full canvas so it does not look shrunk next
  // to other tray apps. Allow a small proportional margin because the 44px
  // HiDPI mask is rasterized from SVG with slightly different rounding.
  const maxMargin = Math.ceil(expectedSize * marginFraction);
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  let offColor = 0;
  for (let y = 0; y < image.height; y += 1) {
    const row = image.pixels[y];
    for (let x = 0; x < image.width; x += 1) {
      const a = row[x * 4 + 3];
      if (a === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (a < 128) continue;
      opaque += 1;
      const r = row[x * 4];
      const g = row[x * 4 + 1];
      const b = row[x * 4 + 2];
      if (
        Math.abs(r - BRAND_RGB[0]) > colorTolerance
        || Math.abs(g - BRAND_RGB[1]) > colorTolerance
        || Math.abs(b - BRAND_RGB[2]) > colorTolerance
      ) {
        offColor += 1;
      }
    }
  }

  assert.ok(
    minX <= maxMargin
      && minY <= maxMargin
      && maxX >= image.width - 1 - maxMargin
      && maxY >= image.height - 1 - maxMargin,
    `${label} glyph must fill the canvas (alpha bounds ${minX},${minY}..${maxX},${maxY})`,
  );
  assert.ok(
    offColor === 0,
    `${label} opaque pixels must be the brand sky blue (off-color pixels: ${offColor})`,
  );
  assert.ok(opaque > 0, `${label} must have visible pixels`);
}

function readIcoEntries(file, label) {
  const ico = fs.readFileSync(file);
  assert.equal(ico.readUInt16LE(0), 0, `${label} reserved field`);
  assert.equal(ico.readUInt16LE(2), 1, `${label} must be an icon resource`);
  const count = ico.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const entry = ico.subarray(6 + i * 16, 6 + (i + 1) * 16);
    const pixelWidth = entry[0] === 0 ? 256 : entry[0];
    const pixelHeight = entry[1] === 0 ? 256 : entry[1];
    const bytesInRes = entry.readUInt32LE(8);
    const imageOffset = entry.readUInt32LE(12);
    entries.push({ pixelWidth, pixelHeight, bytesInRes, imageOffset });
  }
  return entries;
}

test("Linux tray icon is a full-bleed brand-colored glyph", () => {
  assertBrandGlyph(
    fs.readFileSync(path.join(projectRoot, "public/tray-icon.png")),
    22,
    "tray-icon.png",
  );
});

test("Linux tray HiDPI representation matches the base glyph", () => {
  assertBrandGlyph(
    fs.readFileSync(path.join(projectRoot, "public/tray-icon@2x.png")),
    44,
    "tray-icon@2x.png",
  );
});

test("Windows tray .ico carries one glyph entry per notification-area DPI size", () => {
  const file = path.join(projectRoot, "public/tray-icon.ico");
  const expectedSizes = [16, 20, 24, 32, 40, 48, 64];
  const entries = readIcoEntries(file, file);
  assert.deepEqual(
    entries.map((entry) => entry.pixelWidth),
    expectedSizes,
    "the .ico must carry 16/20/24/32/40/48/64 so the shell picks the right size per DPI scale",
  );

  const decoded = entries.map((entry) =>
    readRgbaPng(
      fs.readFileSync(file).subarray(entry.imageOffset, entry.imageOffset + entry.bytesInRes),
      `tray-icon.ico:${entry.pixelWidth}x${entry.pixelHeight}`,
    ),
  );
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(decoded[i].width, entries[i].pixelWidth, `${file} entry ${entries[i].pixelWidth} width`);
    assert.equal(decoded[i].height, entries[i].pixelHeight, `${file} entry ${entries[i].pixelWidth} height`);
  }

  // The smallest entry is what renders at 100 % scaling; make sure it is a
  // brand-colored glyph, not the old navy chip. Allow a slightly larger
  // color tolerance because the entry is a resample of the 44px glyph and
  // resampling overshoots slightly at glyph edges.
  const smallest = fs.readFileSync(file).subarray(
    entries[0].imageOffset,
    entries[0].imageOffset + entries[0].bytesInRes,
  );
  assertBrandGlyph(smallest, 16, "tray-icon.ico 16px entry", { colorTolerance: 25 });
});

test("macOS template masks stay single-color so the system can tint them", () => {
  for (const file of ["public/tray-iconTemplate.png", "public/tray-iconTemplate@2x.png"]) {
    const png = path.join(projectRoot, file);
    const { width, height, pixels } = readPngPixels(fs.readFileSync(png), file);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[y][x * 4 + 3] === 0) continue;
        assert.equal(pixels[y][x * 4], 0, `${file} red channel must stay black`);
        assert.equal(pixels[y][x * 4 + 1], 0, `${file} green channel must stay black`);
        assert.equal(pixels[y][x * 4 + 2], 0, `${file} blue channel must stay black`);
      }
    }
    assert.ok(width > 0 && height > 0);
  }
});
