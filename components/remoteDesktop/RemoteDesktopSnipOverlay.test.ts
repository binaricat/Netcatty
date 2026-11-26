import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSnipSelectionRect } from './RemoteDesktopSnipOverlay';

test('computeSnipSelectionRect normalizes standard full-canvas selection accurately', () => {
  const overlayRect = { left: 0, top: 0, width: 1000, height: 600 };
  const canvasRect = { left: 100, top: 50, width: 800, height: 500 };

  const sel = computeSnipSelectionRect(
    { x: 300, y: 150 },
    { x: 700, y: 400 },
    overlayRect,
    canvasRect,
    1600,
    1000,
  );
  assert.ok(sel);
  assert.deepEqual(sel.displayRect, { left: 300, top: 150, width: 400, height: 250 });
  assert.deepEqual(sel.normalizedRect, {
    x: 250,
    y: 200,
    width: 500,
    height: 500,
    pixelWidth: 800,
    pixelHeight: 500,
  });
});

test('computeSnipSelectionRect maps Monitor 2 slice onto 500..1000 virtual desktop coordinates and clamps to visible overlay', () => {
  // Dual 1920x1080 virtual desktop (3840x1080) sliced to Monitor 2:
  // Overlay shows Monitor 2 in [0..1000, 0..562.5], while translated <canvas> spans [-1000..1000, 0..562.5]
  const overlayRect = { left: 0, top: 0, width: 1000, height: 562.5 };
  const canvasRect = { left: -1000, top: 0, width: 2000, height: 562.5 };

  const sel = computeSnipSelectionRect(
    { x: 200, y: 112.5 },
    { x: 800, y: 450 },
    overlayRect,
    canvasRect,
    3840,
    1080,
  );
  assert.ok(sel);
  // 200px into Monitor 2 = 1200/2000 = 600 permille; width 600/2000 = 300 permille
  assert.equal(sel.normalizedRect.x, 600);
  assert.equal(sel.normalizedRect.width, 300);
  assert.equal(sel.normalizedRect.y, 200);
  assert.equal(sel.normalizedRect.height, 600);

  // Drag starting outside left edge of overlay is clamped to overlayRect.left (0 -> x=500)
  const clamped = computeSnipSelectionRect(
    { x: -200, y: 0 },
    { x: 500, y: 281.25 },
    overlayRect,
    canvasRect,
    3840,
    1080,
  );
  assert.ok(clamped);
  assert.equal(clamped.displayRect.left, 0);
  assert.equal(clamped.displayRect.width, 500);
  assert.equal(clamped.normalizedRect.x, 500);
  assert.equal(clamped.normalizedRect.width, 250);
});
