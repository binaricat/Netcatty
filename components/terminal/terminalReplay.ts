import type { Terminal as XTerm } from "@xterm/xterm";

export type TerminalReplayOptions = {
  chunkBytes?: number;
};

const scheduleFrame = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => resolve());
    return;
  }
  setTimeout(resolve, 0);
});

// The highlighter snapshots this flag synchronously when term.write enters.
// Replay has no PTY pressure samples, so it must not look like live log output.
const replayWrites = new WeakSet<XTerm>();
export const isTerminalReplayWrite = (term: XTerm): boolean => replayWrites.has(term);

const writeChunk = (term: XTerm, data: string): Promise<void> => {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => {
    replayWrites.add(term);
    try {
      term.write(data, () => resolve());
    } finally {
      replayWrites.delete(term);
    }
  });
};

export async function writeTerminalPayloadChunked(
  term: XTerm,
  data: string,
  options: TerminalReplayOptions = {},
): Promise<void> {
  const chunkBytes = Math.max(1024, options.chunkBytes ?? 16 * 1024);
  if (!data) return;
  if (data.length <= chunkBytes) {
    await writeChunk(term, data);
    return;
  }

  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + chunkBytes);
    await writeChunk(term, data.slice(offset, end));
    offset = end;
    if (offset < data.length) {
      await scheduleFrame();
    }
  }
}

export async function writeTerminalReplaySequence(
  term: XTerm,
  segments: string[],
  options: TerminalReplayOptions = {},
): Promise<void> {
  for (const segment of segments) {
    if (!segment) continue;
    await writeTerminalPayloadChunked(term, segment, options);
  }
}
