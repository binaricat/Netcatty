import { DirectoryPickerError, directoryChangeCommand, isDirectoryPath, COMPLETE_DIRECTORY_CAPABILITIES, type DirectoryCapabilities } from '../../domain/directoryPicker';
import { sameDirectoryPath, type DirectoryTarget } from '../../domain/directoryPath';
import type { TerminalDirectoryIO } from '../../infrastructure/services/terminalDirectory';
import { terminalCwdStore } from './terminalCwdStore';

export type TerminalDirectoryController = ReturnType<typeof createTerminalDirectoryController>;

/** One registration represents one connected interactive shell generation. */
export function createTerminalDirectoryController(options: {
  sessionId: string;
  io: TerminalDirectoryIO;
  isCurrent: () => boolean;
  isReady: () => boolean;
  publish: (cwd: string) => void;
  confirmationMs?: number;
  target?: DirectoryTarget;
  capabilities?: DirectoryCapabilities;
  buildChangeCommand?: (path: string) => string | null;
}) {
  const target = Object.freeze({ ...options.target ?? { authority: `session:${options.sessionId}`, pathFlavor: 'posix' as const } });
  const capabilities = Object.freeze({ ...options.capabilities ?? COMPLETE_DIRECTORY_CAPABILITIES });
  const valid = (path: string | null | undefined): path is string => isDirectoryPath(path, target.pathFlavor);
  const same = (a: string, b: string) => sameDirectoryPath(a, b, target.pathFlavor);
  let disposed = false;
  let changing = false;
  let confirmed = false;
  let refreshing: Promise<string> | null = null;
  let refreshAgain = false;
  let cwdError: DirectoryPickerError | null = null;
  const lifetime = new AbortController();
  const current = () => !disposed && options.isCurrent();
  function check(signal?: AbortSignal) {
    if (!current() || signal?.aborted) throw new DirectoryPickerError('unavailable');
  }
  function ready() {
    check();
    if (!options.isReady()) throw new DirectoryPickerError('busy');
  }
  function bounded<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener('abort', cancel);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value!);
      };
      const cancel = () => finish(new DirectoryPickerError('unavailable'));
      const timer = setTimeout(() => finish(new DirectoryPickerError('readFailed')), 5000);
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || lifetime.signal.aborted) cancel();
      task.then(value => finish(undefined, value), error => finish(error));
    });
  }
  async function refresh(submittedRevision?: number): Promise<string> {
    check();
    if (!capabilities.readCwd) throw new DirectoryPickerError('unavailable');
    const activeShellCwd = () => {
      const cwd = terminalCwdStore.getCwd(options.sessionId);
      return target.pathFlavor === 'posix' && valid(cwd) && terminalCwdStore.getSource(options.sessionId) === 'osc7'
        && (submittedRevision === undefined || terminalCwdStore.getSessionRevision(options.sessionId) !== submittedRevision)
        ? cwd : null;
    };
    // A process probe may read the outer PTY shell while a nested shell is
    // active. OSC 7 remains authoritative across debounce delays, completion
    // events and picker remounts. Only a cd submission may probe past its own
    // pre-write report while waiting for fresh confirmation.
    const reported = activeShellCwd();
    if (reported) { confirmed = true; cwdError = null; return reported; }
    if (refreshing) {
      // Output may settle while a pre-cd query is still in flight. Keep one
      // follow-up query so that its older result cannot be the last update.
      refreshAgain = true;
      return refreshing;
    }
    const pending = (async () => {
      let cwd: string;
      try {
        cwd = await bounded(options.io.cwd());
        if (!valid(cwd)) throw new DirectoryPickerError('unknown');
      } catch (error) {
        if (current() && target.pathFlavor === 'win32') {
          confirmed = false;
          cwdError = error instanceof DirectoryPickerError ? error : new DirectoryPickerError('unknown');
          options.publish('');
        }
        throw error;
      }
      check();
      const reported = activeShellCwd();
      const live = terminalCwdStore.getCwd(options.sessionId);
      confirmed = true;
      cwdError = null;
      if (reported) return reported;
      if (live !== cwd || terminalCwdStore.getSource(options.sessionId) === 'stale') options.publish(cwd);
      return cwd;
    })();
    refreshing = pending;
    try { return await pending; } finally {
      if (refreshing === pending) refreshing = null;
      if (refreshAgain && current()) {
        refreshAgain = false;
        void refresh().catch(() => {});
      }
    }
  }
  async function change(path: string, signal: AbortSignal, accepted: () => void, expectedCwd?: string, expectedRevision?: number) {
    ready();
    check(signal);
    if (!capabilities.changeDirectory || !capabilities.confirmChange) throw new DirectoryPickerError('unavailable');
    if (changing) throw new DirectoryPickerError('busy');
    const command = valid(path) ? (options.buildChangeCommand ?? (value => directoryChangeCommand(value, 'posix', target.pathFlavor)))(path) : null;
    if (!command) throw new DirectoryPickerError('unsupportedPath');
    changing = true;
    let confirmationFinished = false;
    try {
      const canonical = await bounded(options.io.realpath(path, signal), signal);
      if (options.io.validateChange) await bounded(options.io.validateChange(expectedCwd), signal);
      check(signal);
      if (!valid(canonical)) throw new DirectoryPickerError('unsupportedPath');
      ready(); // The shell can become busy while resolving a remote symlink.
      if (expectedCwd && terminalCwdStore.getCwd(options.sessionId) !== expectedCwd) throw new DirectoryPickerError('unavailable');
      if (expectedRevision !== undefined && terminalCwdStore.getSessionRevision(options.sessionId) !== expectedRevision) throw new DirectoryPickerError('unavailable');
      const submittedRevision = terminalCwdStore.getSessionRevision(options.sessionId);
      options.io.write(command + '\r');
      accepted();
      const deadline = Date.now() + (options.confirmationMs ?? 8000);
      const hasFreshOsc7 = () => {
        const cwd = terminalCwdStore.getCwd(options.sessionId);
        return target.pathFlavor === 'posix' && valid(cwd) && terminalCwdStore.getSessionRevision(options.sessionId) !== submittedRevision
          && terminalCwdStore.getSource(options.sessionId) === 'osc7'
          && (same(cwd, path) || same(cwd, canonical));
      };
      const pause = () => new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 200);
        lifetime.signal.addEventListener('abort', done, { once: true });
      });
      const confirmFromProbe = async () => {
        while (!confirmationFinished && Date.now() < deadline) {
          check(signal);
          if (hasFreshOsc7()) return;
          if (options.isReady()) {
            try {
              const cwd = await refresh(submittedRevision);
              check(signal);
              if (same(cwd, path) || same(cwd, canonical) || same(await bounded(options.io.realpath(cwd, signal), signal), canonical)) return;
            } catch (error) {
              if (!current() || signal.aborted) throw error;
            }
          }
          await pause();
        }
        if (!confirmationFinished) throw new DirectoryPickerError('changeFailed');
      };
      // OSC 7 is authoritative even when process cwd lookup is unavailable or
      // stalled. Poll revisions too: an unchanged OSC 7 path emits no store event.
      const confirmFromOsc7 = async () => {
        while (!confirmationFinished) {
          check(signal);
          if (hasFreshOsc7()) return;
          if (Date.now() >= deadline) throw new DirectoryPickerError('changeFailed');
          await pause();
        }
      };
      await Promise.race([confirmFromProbe(), confirmFromOsc7()]);
      check(signal);
      confirmed = true;
    } finally { confirmationFinished = true; changing = false; }
  }
  return {
    target,
    capabilities,
    getCwdError: () => cwdError?.code ?? null,
    refresh: () => refresh(),
    hasConfirmedCwd: () => confirmed,
    async home() {
      check();
      const result = await bounded(options.io.home?.() ?? Promise.resolve(null));
      check(); return valid(result) ? result : null;
    },
    async list(path: string, signal: AbortSignal) {
      check(signal);
      if (!capabilities.listDirectories) throw new DirectoryPickerError('unavailable');
      if (!valid(path)) throw new DirectoryPickerError('unsupportedPath');
      const result = await bounded(options.io.list(path, signal), signal);
      check(signal);
      return result;
    },
    change,
    dispose() { disposed = true; lifetime.abort(); },
  };
}
