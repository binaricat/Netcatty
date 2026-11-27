import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureRemoteDesktopFrame,
  clearCapturedRemoteDesktopFramesForSession,
  computeRemoteDesktopCaptureGeometry,
  computeRemoteDesktopGridLayout,
  drawRemoteDesktopCoordinateGrid,
  getCapturedRemoteDesktopFrame,
  hasRemoteDesktopSnapshotProvider,
  isRemoteDesktopAiReadBlocked,
  MAX_REMOTE_DESKTOP_CACHED_FRAMES,
  normalizeRemoteDesktopCrop,
  parseFlatRemoteDesktopCropParams,
  registerRemoteDesktopSnapshotProvider,
  resetRemoteDesktopSnapshotRegistryForTests,
  setRemoteDesktopAiReadBlocked,
  subscribeRemoteDesktopAiReadBlocked,
  subscribeRemoteDesktopCaptureEvents,
  type RemoteDesktopCaptureEvent,
} from './remoteDesktopSnapshotRegistry';

describe('remoteDesktopSnapshotRegistry', () => {
  beforeEach(() => {
    resetRemoteDesktopSnapshotRegistryForTests();
  });

  it('registers, captures lightweight metadata, caches base64 in LRU, and emits capture events', async () => {
    const events: RemoteDesktopCaptureEvent[] = [];
    const unsubEvent = subscribeRemoteDesktopCaptureEvents('rdp-1', (ev) => events.push(ev));
    const unsubProvider = registerRemoteDesktopSnapshotProvider('rdp-1', async (opts) => ({
      base64Data: 'data:image/jpeg;base64,QUJDRA==',
      mediaType: 'image/jpeg',
      width: 1280,
      height: 720,
      naturalWidth: 1920,
      naturalHeight: 1080,
      crop: opts?.crop,
      protocol: 'rdp',
      hostLabel: 'win-prod',
      hostname: '10.0.0.10',
    }));

    assert.equal(hasRemoteDesktopSnapshotProvider('rdp-1'), true);

    const res = await captureRemoteDesktopFrame('rdp-1', {
      quality: 'standard',
      crop: { x: 100, y: 200, width: 300, height: 250 },
      source: 'ai-tool',
    });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal('base64Data' in res, false, 'returned metadata must never contain base64Data');
      assert.equal(res.sessionId, 'rdp-1');
      assert.equal(res.protocol, 'rdp');
      assert.equal(res.width, 1280);
      assert.equal(res.height, 720);
      assert.deepEqual(res.crop, { x: 100, y: 200, width: 300, height: 250 });
      assert.equal(res.byteLength, 4);

      const cached = getCapturedRemoteDesktopFrame(res.captureId);
      assert.ok(cached);
      assert.equal(cached.base64Data, 'QUJDRA==');
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'ai-tool');
    assert.deepEqual(events[0].crop, { x: 100, y: 200, width: 300, height: 250 });

    unsubEvent();
    unsubProvider();
    assert.equal(hasRemoteDesktopSnapshotProvider('rdp-1'), false);
  });

  it('enforces per-session privacy lock for ai-tool captures while still permitting user captures', async () => {
    registerRemoteDesktopSnapshotProvider('vnc-1', () => ({
      base64Data: 'QUJDRA==',
      mediaType: 'image/jpeg',
      width: 800,
      height: 600,
      naturalWidth: 800,
      naturalHeight: 600,
      protocol: 'vnc',
    }));

    const lockStates: boolean[] = [];
    const unsubLock = subscribeRemoteDesktopAiReadBlocked('vnc-1', (blocked) => lockStates.push(blocked));

    setRemoteDesktopAiReadBlocked('vnc-1', true);
    assert.equal(isRemoteDesktopAiReadBlocked('vnc-1'), true);
    assert.deepEqual(lockStates, [true]);

    const aiRes = await captureRemoteDesktopFrame('vnc-1', { source: 'ai-tool' });
    assert.equal(aiRes.ok, false);
    if (!aiRes.ok) {
      assert.equal(aiRes.code, 'PRIVACY_BLOCKED');
    }

    const userRes = await captureRemoteDesktopFrame('vnc-1', { source: 'user-snip' });
    assert.equal(userRes.ok, true);

    setRemoteDesktopAiReadBlocked('vnc-1', false);
    assert.deepEqual(lockStates, [true, false]);
    const aiAllowed = await captureRemoteDesktopFrame('vnc-1', { source: 'ai-tool' });
    assert.equal(aiAllowed.ok, true);
    unsubLock();
  });

  it('bounds the in-memory frame cache to MAX_REMOTE_DESKTOP_CACHED_FRAMES with LRU eviction and session cleanup', async () => {
    registerRemoteDesktopSnapshotProvider('s1', () => ({
      base64Data: 'QUJD',
      mediaType: 'image/jpeg',
      width: 640,
      height: 480,
      naturalWidth: 640,
      naturalHeight: 480,
    }));
    registerRemoteDesktopSnapshotProvider('s2', () => ({
      base64Data: 'QUJD',
      mediaType: 'image/jpeg',
      width: 640,
      height: 480,
      naturalWidth: 640,
      naturalHeight: 480,
    }));

    const ids: string[] = [];
    for (let i = 0; i < MAX_REMOTE_DESKTOP_CACHED_FRAMES + 2; i += 1) {
      const res = await captureRemoteDesktopFrame(i % 2 === 0 ? 's1' : 's2');
      assert.equal(res.ok, true);
      if (res.ok) ids.push(res.captureId);
      // Touch frame 0 right before eviction to verify LRU recency refresh.
      if (i === MAX_REMOTE_DESKTOP_CACHED_FRAMES - 1) {
        assert.ok(getCapturedRemoteDesktopFrame(ids[0]));
      }
    }

    // Frame 0 was touched so it stays; frames 1 and 2 were evicted.
    assert.ok(getCapturedRemoteDesktopFrame(ids[0]));
    assert.equal(getCapturedRemoteDesktopFrame(ids[1]), undefined);
    assert.equal(getCapturedRemoteDesktopFrame(ids[2]), undefined);
    assert.ok(getCapturedRemoteDesktopFrame(ids[ids.length - 1]));

    const removed = clearCapturedRemoteDesktopFramesForSession('s1');
    assert.ok(removed > 0);
    assert.equal(getCapturedRemoteDesktopFrame(ids[0]), undefined);
    assert.ok(getCapturedRemoteDesktopFrame(ids[ids.length - 1]));
  });

  it('validates crop coordinates and computes 1:1 native-pixel geometry with PNG upgrade for small crops', () => {
    assert.equal(parseFlatRemoteDesktopCropParams({}).crop, undefined);
    assert.ok(parseFlatRemoteDesktopCropParams({ cropX: 10, cropY: 20 }).error);
    assert.ok(normalizeRemoteDesktopCrop({ x: -1, y: 0, width: 100, height: 100 }).error);
    assert.ok(normalizeRemoteDesktopCrop({ x: 100, y: 100, width: 0, height: 100 }).error);
    assert.deepEqual(
      normalizeRemoteDesktopCrop({ x: 900, y: 800, width: 300, height: 500 }).crop,
      { x: 900, y: 800, width: 100, height: 200 },
    );

    const standardFull = computeRemoteDesktopCaptureGeometry(2560, 1440, { quality: 'standard' });
    assert.ok(standardFull);
    assert.equal(standardFull.outWidth, 1280);
    assert.equal(standardFull.outHeight, 720);
    assert.equal(standardFull.mediaType, 'image/jpeg');
    assert.equal(standardFull.jpegQuality, 0.80);

    const highFull = computeRemoteDesktopCaptureGeometry(2560, 1440, { quality: 'high' });
    assert.ok(highFull);
    assert.equal(highFull.outWidth, 1920);
    assert.equal(highFull.outHeight, 1080);
    assert.equal(highFull.mediaType, 'image/jpeg');
    assert.equal(highFull.jpegQuality, 0.92);

    // Small crop stays at 1:1 native pixels and auto-upgrades to lossless PNG.
    const smallCrop = computeRemoteDesktopCaptureGeometry(1920, 1080, {
      quality: 'standard',
      crop: { x: 250, y: 250, width: 250, height: 200 },
    });
    assert.ok(smallCrop);
    assert.equal(smallCrop.sx, 480);
    assert.equal(smallCrop.sy, 270);
    assert.equal(smallCrop.sw, 480);
    assert.equal(smallCrop.sh, 216);
    assert.equal(smallCrop.outWidth, 480);
    assert.equal(smallCrop.outHeight, 216);
    assert.equal(smallCrop.mediaType, 'image/png');
  });

  it('computes 0..1000 coordinate grid layout for full-screen and cropped frames with global labels', () => {
    const full = computeRemoteDesktopGridLayout(1000, 500);
    assert.deepEqual(
      full.vertical.map((l) => l.permille),
      [100, 200, 300, 400, 500, 600, 700, 800, 900],
    );
    assert.equal(full.vertical.every((l) => l.major && l.label === String(l.permille)), true);
    assert.equal(full.vertical[0].pixel, 100);
    assert.equal(full.horizontal[0].pixel, 50);

    // Cropped region (width/height <= 500) adds 50-unit minor lines and keeps global 0..1000 labels
    const cropped = computeRemoteDesktopGridLayout(400, 400, {
      x: 200,
      y: 300,
      width: 400,
      height: 400,
    });
    assert.deepEqual(
      cropped.vertical.map((l) => l.permille),
      [250, 300, 350, 400, 450, 500, 550],
    );
    assert.equal(cropped.vertical[0].major, false);
    assert.equal(cropped.vertical[0].pixel, 50);
    assert.equal(cropped.vertical[1].major, true);
    assert.equal(cropped.vertical[1].label, '300');
    assert.equal(cropped.vertical[1].pixel, 100);

    assert.deepEqual(
      cropped.horizontal.map((l) => l.permille),
      [350, 400, 450, 500, 550, 600, 650],
    );
    assert.equal(cropped.horizontal[1].label, '400');
  });

  it('draws coordinate grid onto an offscreen canvas context and forwards grid flag through captureRemoteDesktopFrame', async () => {
    const strokes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const labels: string[] = [];
    let moveX = 0;
    let moveY = 0;
    const mockCtx = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo(x: number, y: number) {
        moveX = x;
        moveY = y;
      },
      lineTo(x: number, y: number) {
        strokes.push({ x1: moveX, y1: moveY, x2: x, y2: y });
      },
      stroke() {},
      fillRect() {},
      fillText(text: string) {
        labels.push(text);
      },
      measureText(text: string) {
        return { width: text.length * 7 };
      },
      lineWidth: 1,
      strokeStyle: '',
      fillStyle: '',
      font: '',
      textBaseline: 'top',
    } as unknown as CanvasRenderingContext2D;

    drawRemoteDesktopCoordinateGrid(mockCtx, 1000, 600, {
      x: 200,
      y: 100,
      width: 300,
      height: 300,
    });

    assert.ok(strokes.length > 0);
    assert.ok(labels.includes('300'));
    assert.ok(labels.includes('400'));
    assert.ok(labels.includes('200'));

    let receivedGridFlag: boolean | undefined;
    registerRemoteDesktopSnapshotProvider('rdp-grid', (opts) => {
      receivedGridFlag = opts?.grid;
      return {
        base64Data: 'QUJD',
        mediaType: 'image/jpeg',
        width: 1280,
        height: 720,
        naturalWidth: 1280,
        naturalHeight: 720,
        grid: opts?.grid,
        protocol: 'rdp',
      };
    });

    const res = await captureRemoteDesktopFrame('rdp-grid', { grid: true });
    assert.equal(receivedGridFlag, true);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.grid, true);
    }
  });
});
