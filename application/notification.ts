/**
 * Application-layer notification port.
 *
 * UI layers (e.g. toast) register their implementation via `setNotify`.
 * Application code calls `notify.*` without importing any UI module.
 */

export interface NotifyOptions {
  title?: string;
  duration?: number;
  onClick?: () => void;
  actionLabel?: string;
}

type NotifyFn = (message: string, titleOrOptions?: string | NotifyOptions) => void;

interface Notify {
  success: NotifyFn;
  error: NotifyFn;
  warning: NotifyFn;
  info: NotifyFn;
}

const noop: NotifyFn = () => {};

let _impl: Notify = { success: noop, error: noop, warning: noop, info: noop };

/** Called once by the UI layer to wire up the real implementation. */
export function setNotify(impl: Notify): void {
  _impl = impl;
}

export const notify: Notify = {
  success: (...args) => _impl.success(...args),
  error: (...args) => _impl.error(...args),
  warning: (...args) => _impl.warning(...args),
  info: (...args) => _impl.info(...args),
};
