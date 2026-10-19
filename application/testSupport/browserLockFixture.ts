/** Web Locks fixture for tests with a simulated browser window. */
export function installBrowserLockFixture(): void {
  const states = new Map<string, {
    readers: number;
    writer: boolean;
    pending: Array<{ mode: LockMode; grant: () => void }>;
  }>();
  const locks = {
    async request<T>(
      name: string,
      optionsOrTask: LockOptions | ((lock: Pick<Lock, "name" | "mode"> | null) => T | Promise<T>),
      callback?: (lock: Pick<Lock, "name" | "mode"> | null) => T | Promise<T>,
    ): Promise<T> {
      const options = typeof optionsOrTask === "function" ? {} : optionsOrTask;
      const task = typeof optionsOrTask === "function" ? optionsOrTask : callback!;
      const mode = options.mode ?? "exclusive";
      const state = states.get(name) ?? { readers: 0, writer: false, pending: [] };
      states.set(name, state);
      if (options.ifAvailable && (state.writer || state.pending.length || (mode === "exclusive" && state.readers))) {
        return task(null);
      }
      const drain = () => {
        while (!state.writer && state.pending.length) {
          const next = state.pending[0];
          if (next.mode === "exclusive" && state.readers) return;
          state.pending.shift();
          if (next.mode === "exclusive") state.writer = true;
          else state.readers += 1;
          next.grant();
        }
      };
      return new Promise<T>((resolve, reject) => {
        state.pending.push({ mode, grant: () => {
          void (async () => {
            try {
              return await task({ name, mode });
            } finally {
              if (mode === "exclusive") state.writer = false;
              else state.readers -= 1;
              drain();
            }
          })().then(resolve, reject);
        } });
        drain();
      });
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
}
