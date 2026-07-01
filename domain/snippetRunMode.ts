import type { Snippet } from "./models";

export function resolveSnippetMultiLineRunMode(
  mode?: Snippet["multiLineRunMode"],
): NonNullable<Snippet["multiLineRunMode"]> {
  return mode === "lineDelay" ? "lineDelay" : "paste";
}
