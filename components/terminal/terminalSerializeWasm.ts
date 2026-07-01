/**
 * Optional WASM-backed terminal serialize hook.
 *
 * xterm.js upstream is exploring a WASM serialize addon (~10x faster for large
 * scrollback). Until a stable package ships alongside @xterm/addon-serialize,
 * this module feature-detects and falls back to the JS SerializeAddon.
 */

export type TerminalSerializeFn = (options?: Record<string, unknown>) => string;

let wasmSerializeLoader: (() => Promise<TerminalSerializeFn | null>) | null = null;

export function registerWasmSerializeLoader(
  loader: () => Promise<TerminalSerializeFn | null>,
): void {
  wasmSerializeLoader = loader;
}

export async function resolveTerminalSerializeFn(
  jsSerialize: TerminalSerializeFn,
  preferWasm: boolean,
): Promise<TerminalSerializeFn> {
  if (!preferWasm || !wasmSerializeLoader) {
    return jsSerialize;
  }
  try {
    const wasmSerialize = await wasmSerializeLoader();
    if (wasmSerialize) return wasmSerialize;
  } catch {
    // Fall back to JS serialize below.
  }
  return jsSerialize;
}
