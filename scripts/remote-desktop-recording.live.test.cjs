"use strict";
/* global process, __dirname, console */
if (!process.versions.electron) {
  require("node:test")("remote desktop recording end-to-end Electron smoke test", {
    skip: "run with Electron to exercise real MediaRecorder, netcatty-media://, and video playback",
  }, () => {});
} else {
  const { app, BrowserWindow, ipcMain, protocol } = require("electron");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const esbuild = require("esbuild");

  const {
    RECORDING_MEDIA_SCHEME,
    createRemoteDesktopRecordingsBridge,
  } = require("../electron/bridges/remoteDesktopRecordingsBridge.cjs");

  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-rdp-rec-smoke-"));
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});

  protocol.registerSchemesAsPrivileged([
    {
      scheme: RECORDING_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);

  let win;
  const cleanup = (code) => {
    try {
      win?.destroy();
    } catch {
      // ignore
    }
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };

  let bundle;
  try {
    bundle = esbuild.buildSync({
      stdin: {
        contents: [
          'export { createStableCanvasCaptureStream, captureCanvasThumbnailJpeg } from "./components/remoteDesktop/remoteDesktopVideoCapture";',
          'export { pickRemoteDesktopRecordingMimeType } from "./components/remoteDesktop/useRemoteDesktopRecorder";',
        ].join("\n"),
        loader: "ts",
        resolveDir: root,
      },
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "chrome130",
      write: false,
      define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
    }).outputFiles[0].text;
  } catch (error) {
    console.error(error);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(1);
  }

  void app.whenReady().then(async () => {
    const recordingsBridge = createRemoteDesktopRecordingsBridge({
      recordingsDir: path.join(userData, "recordings"),
    });
    recordingsBridge.registerHandlers(ipcMain);
    protocol.handle(RECORDING_MEDIA_SCHEME, (request) => (
      recordingsBridge.handleMediaProtocolRequest(request)
    ));

    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });

    await win.loadURL("data:text/html,<body style='margin:0;background:%23111'><div id='root'></div></body>");

    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      const { ipcRenderer } = require('electron');
      const loaded = { exports: {} };
      ((module, exports) => { ${bundle} })(loaded, loaded.exports);
      const {
        createStableCanvasCaptureStream,
        captureCanvasThumbnailJpeg,
        pickRemoteDesktopRecordingMimeType,
      } = loaded.exports;

      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      document.getElementById('root').appendChild(canvas);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(100, 100, 200, 120);

      // 1. Capture JPEG thumbnail
      const jpegBytes = await captureCanvasThumbnailJpeg(canvas);
      assert.ok(jpegBytes && jpegBytes.byteLength > 100, 'thumbnail JPEG should be non-empty');
      assert.equal(jpegBytes[0], 0xff);
      assert.equal(jpegBytes[1], 0xd8);

      // 2. Begin recording via IPC + captureStream + MediaRecorder + mid-recording dynamic resize
      const capture = createStableCanvasCaptureStream(canvas, 10);
      assert.ok(capture, 'capture handle should be created');
      assert.equal(capture.width, 1280);
      assert.equal(capture.height, 720);

      const mimeType = pickRemoteDesktopRecordingMimeType(false) || 'video/webm';
      const { recordingId } = await ipcRenderer.invoke('netcatty:remote-desktop-recording:begin', {
        mimeType,
        hostLabel: 'smoke-rdp',
        protocol: 'rdp',
      });
      const thumbSaved = await ipcRenderer.invoke('netcatty:remote-desktop-recording:save-thumbnail', {
        id: recordingId,
        data: jpegBytes,
      });
      assert.equal(thumbSaved.ok, true);

      const recorder = new MediaRecorder(capture.stream, { mimeType, videoBitsPerSecond: 1_500_000 });
      let appendChain = Promise.resolve();
      let chunkCount = 0;
      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size <= 0) return;
        chunkCount += 1;
        const blob = ev.data;
        appendChain = appendChain.then(async () => {
          const buf = await blob.arrayBuffer();
          await ipcRenderer.invoke('netcatty:remote-desktop-recording:append', {
            recordingId,
            chunk: new Uint8Array(buf),
          });
        });
      };

      recorder.start(300);
      await new Promise((r) => setTimeout(r, 450));

      // Simulate dynamic RDP canvas resize mid-recording!
      canvas.width = 800;
      canvas.height = 600;
      ctx.fillStyle = '#065f46';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise((r) => setTimeout(r, 450));

      await new Promise((resolve) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.stop();
      });
      capture.dispose();
      await appendChain;

      // Verify all tracks stopped cleanly after dispose()
      for (const track of capture.stream.getTracks()) {
        assert.equal(track.readyState, 'ended', 'video track must be ended after dispose()');
      }

      const finished = await ipcRenderer.invoke('netcatty:remote-desktop-recording:finish', {
        recordingId,
        durationMs: 1200,
        hasAudio: false,
      });
      assert.ok(finished.bytes > 0, 'finalized .webm must be non-empty');
      assert.ok(chunkCount > 0, 'MediaRecorder must emit chunks');

      // 3. Verify thumbnail renders over netcatty-media://thumbnail/<id>
      const thumbInfo = await ipcRenderer.invoke('netcatty:remote-desktop-recording:get-thumbnail-url', {
        id: recordingId,
      });
      assert.equal(thumbInfo.exists, true);
      const imgLoaded = await new Promise((resolve, reject) => {
        const img = document.createElement('img');
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('Thumbnail failed to load over netcatty-media://'));
        img.src = thumbInfo.url;
      });
      assert.ok(imgLoaded.w > 0 && imgLoaded.w <= 320, 'thumbnail width should be <= 320px');

      // 4. Verify <video> loads patched duration and seeks over netcatty-media://recording/<id>
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      document.getElementById('root').appendChild(video);
      const videoMeta = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out loading video metadata')), 5000);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve({
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          });
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Video playback error: ' + (video.error?.message || video.error?.code)));
        };
        video.src = finished.playbackUrl;
      });
      assert.ok(Number.isFinite(videoMeta.duration) && videoMeta.duration > 0.5, 'patched WebM duration must be finite and > 0.5s');
      assert.equal(videoMeta.videoWidth, 1280);
      assert.equal(videoMeta.videoHeight, 720);

      // Seek test
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out seeking video')), 3000);
        video.onseeked = () => {
          clearTimeout(timer);
          resolve();
        };
        video.currentTime = 0.5;
      });
      assert.ok(video.currentTime >= 0.4, 'video seek should land near 0.5s');

      // Clean video release
      video.pause();
      video.removeAttribute('src');
      video.load();

      // 5. Verify cascade delete removes both .webm and .jpg
      await ipcRenderer.invoke('netcatty:remote-desktop-recording:delete', { recordingId });
      const afterPlay = await ipcRenderer.invoke('netcatty:remote-desktop-recording:get-playback-url', { recordingId });
      const afterThumb = await ipcRenderer.invoke('netcatty:remote-desktop-recording:get-thumbnail-url', { id: recordingId });
      assert.equal(afterPlay.exists, false);
      assert.equal(afterThumb.exists, false);

      return {
        bytes: finished.bytes,
        chunkCount,
        duration: videoMeta.duration,
        thumbWidth: imgLoaded.w,
        thumbHeight: imgLoaded.h,
      };
    })()`);

    console.log("[Smoke] RDP recording Electron E2E passed:", JSON.stringify(result));
    cleanup(0);
  }).catch((err) => {
    console.error("[Smoke] RDP recording Electron E2E FAILED:", err);
    cleanup(1);
  });
}
