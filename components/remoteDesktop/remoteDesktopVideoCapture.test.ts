import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeAspectFitRect,
  computeRecordingCanvasDimensions,
} from './remoteDesktopVideoCapture';

test('computeRecordingCanvasDimensions caps 4K/HiDPI canvases at even-aligned 1080p', () => {
  assert.deepEqual(computeRecordingCanvasDimensions(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(computeRecordingCanvasDimensions(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(computeRecordingCanvasDimensions(1281, 721), { width: 1280, height: 720 });
  assert.deepEqual(computeRecordingCanvasDimensions(2560, 1600), { width: 1728, height: 1080 });
});

test('computeAspectFitRect letterboxes resized source cleanly inside fixed recording canvas', () => {
  assert.deepEqual(computeAspectFitRect(1920, 1080, 1920, 1080), {
    dx: 0,
    dy: 0,
    dw: 1920,
    dh: 1080,
  });
  // Square source inside 16:9 target -> centered horizontally
  assert.deepEqual(computeAspectFitRect(1000, 1000, 1920, 1080), {
    dx: 420,
    dy: 0,
    dw: 1080,
    dh: 1080,
  });
});
