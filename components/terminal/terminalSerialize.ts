import type { Terminal as XTerm } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

import { resolveTerminalSerializeFn } from "./terminalSerializeWasm";

export type TerminalSerializeRequest = {
  term: XTerm;
  serializeAddon: SerializeAddon;
  options?: Record<string, unknown>;
  preferWasm?: boolean;
};

export async function serializeTerminalBuffer(
  request: TerminalSerializeRequest,
): Promise<string> {
  const serialize = await resolveTerminalSerializeFn(
    (options) => request.serializeAddon.serialize(options),
    request.preferWasm === true,
  );
  return serialize(request.options);
}
