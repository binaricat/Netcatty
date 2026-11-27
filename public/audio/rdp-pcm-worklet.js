/* global AudioWorkletProcessor, registerProcessor */
/**
 * Static 'self' AudioWorkletProcessor for RDP RDPSND audio playback.
 * Receives 16-bit little-endian interleaved stereo (or mono) PCM frames over
 * MessagePort and plays them smoothly through a bounded ring buffer with gain
 * and flush/reset controls.
 *
 * Loaded via `audioContext.audioWorklet.addModule('./audio/rdp-pcm-worklet.js')`
 * so Content-Security-Policy never requires `blob:` under `script-src`.
 */

const DEFAULT_BUFFER_FRAMES = 48000; // ~1s at 48 kHz

class RdpPcmWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    const requestedFrames = Number(processorOptions.bufferFrames);
    this.capacity = Number.isFinite(requestedFrames) && requestedFrames >= 2048
      ? Math.min(Math.floor(requestedFrames), 48000 * 4)
      : DEFAULT_BUFFER_FRAMES;
    this.leftBuffer = new Float32Array(this.capacity);
    this.rightBuffer = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.availableFrames = 0;
    this.volume = 1.0;
    this.muted = false;

    this.port.onmessage = (event) => {
      this._handleMessage(event.data);
    };
  }

  _handleMessage(msg) {
    if (!msg) return;
    if (msg instanceof ArrayBuffer) {
      this._enqueuePcm16(new Int16Array(msg), 2);
      return;
    }
    if (ArrayBuffer.isView(msg)) {
      const int16 = msg instanceof Int16Array
        ? msg
        : new Int16Array(msg.buffer, msg.byteOffset, Math.floor(msg.byteLength / 2));
      this._enqueuePcm16(int16, 2);
      return;
    }
    switch (msg.type) {
      case "pcm": {
        const channels = msg.channels === 1 ? 1 : 2;
        if (msg.samples instanceof Float32Array) {
          this._enqueueFloat32(msg.samples, channels);
        } else if (msg.samples instanceof Int16Array) {
          this._enqueuePcm16(msg.samples, channels);
        } else if (msg.buffer instanceof ArrayBuffer) {
          this._enqueuePcm16(new Int16Array(msg.buffer), channels);
        } else if (ArrayBuffer.isView(msg.buffer)) {
          this._enqueuePcm16(
            new Int16Array(
              msg.buffer.buffer,
              msg.buffer.byteOffset,
              Math.floor(msg.buffer.byteLength / 2),
            ),
            channels,
          );
        }
        break;
      }
      case "volume": {
        if (typeof msg.volume === "number" && Number.isFinite(msg.volume)) {
          this.volume = Math.max(0, Math.min(2, msg.volume));
        }
        if (typeof msg.muted === "boolean") {
          this.muted = msg.muted;
        }
        break;
      }
      case "mute": {
        this.muted = Boolean(msg.muted);
        break;
      }
      case "flush":
      case "reset": {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.availableFrames = 0;
        break;
      }
      default:
        break;
    }
  }

  _enqueuePcm16(int16, channels) {
    const frameCount = channels === 1 ? int16.length : Math.floor(int16.length / 2);
    if (frameCount <= 0) return;

    // If incoming chunk alone exceeds capacity, keep only the newest tail.
    let startFrame = 0;
    if (frameCount > this.capacity) {
      startFrame = frameCount - this.capacity;
    }
    const toWrite = frameCount - startFrame;

    // Drop oldest buffered frames on overrun to keep latency bounded.
    const overflow = this.availableFrames + toWrite - this.capacity;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.availableFrames = Math.max(0, this.availableFrames - overflow);
    }

    const scale = 1 / 32768;
    for (let f = startFrame; f < frameCount; f += 1) {
      let l;
      let r;
      if (channels === 1) {
        l = int16[f] * scale;
        r = l;
      } else {
        const idx = f * 2;
        l = int16[idx] * scale;
        r = int16[idx + 1] * scale;
      }
      this.leftBuffer[this.writeIndex] = l;
      this.rightBuffer[this.writeIndex] = r;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.availableFrames += toWrite;
  }

  _enqueueFloat32(floats, channels) {
    const frameCount = channels === 1 ? floats.length : Math.floor(floats.length / 2);
    if (frameCount <= 0) return;

    let startFrame = 0;
    if (frameCount > this.capacity) {
      startFrame = frameCount - this.capacity;
    }
    const toWrite = frameCount - startFrame;

    const overflow = this.availableFrames + toWrite - this.capacity;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.availableFrames = Math.max(0, this.availableFrames - overflow);
    }

    for (let f = startFrame; f < frameCount; f += 1) {
      let l;
      let r;
      if (channels === 1) {
        l = floats[f];
        r = l;
      } else {
        const idx = f * 2;
        l = floats[idx];
        r = floats[idx + 1];
      }
      this.leftBuffer[this.writeIndex] = l;
      this.rightBuffer[this.writeIndex] = r;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.availableFrames += toWrite;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outLeft = output[0];
    const outRight = output.length > 1 ? output[1] : null;
    const blockFrames = outLeft.length;
    const gain = this.muted ? 0 : this.volume;

    if (this.availableFrames === 0) {
      outLeft.fill(0);
      if (outRight) outRight.fill(0);
      return true;
    }

    const framesToRead = Math.min(blockFrames, this.availableFrames);
    for (let i = 0; i < framesToRead; i += 1) {
      const idx = this.readIndex;
      const l = this.leftBuffer[idx] * gain;
      const r = this.rightBuffer[idx] * gain;
      outLeft[i] = outRight ? l : (l + r) * 0.5;
      if (outRight) outRight[i] = r;
      this.readIndex = (idx + 1) % this.capacity;
    }
    this.availableFrames -= framesToRead;

    if (framesToRead < blockFrames) {
      outLeft.fill(0, framesToRead);
      if (outRight) outRight.fill(0, framesToRead);
    }

    return true;
  }
}

registerProcessor("rdp-pcm-worklet", RdpPcmWorkletProcessor);
