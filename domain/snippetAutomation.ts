import type { Host, Snippet } from "./models";
import { applySnippetVariables } from "./snippetVariables";

export type SnippetVariableValuesProvider = (snippet: Snippet) => Record<string, string>;

const normalizeCommandBlock = (command: string | undefined): string | null => {
  if (!command || command.trim().length === 0) return null;
  return command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");
};

export const shouldRunSnippetOnHostConnect = (
  snippet: Pick<Snippet, "command" | "runOnConnect" | "targets">,
  hostId: string,
): boolean => (
  snippet.runOnConnect === true
  && snippet.command.trim().length > 0
  && Array.isArray(snippet.targets)
  && snippet.targets.includes(hostId)
);

export const resolveSnippetAutomationCommand = (
  snippet: Snippet,
  values: Record<string, string> = {},
): string | null => {
  const result = applySnippetVariables(snippet.command, values);
  if (!result.ok) return null;
  return normalizeCommandBlock(result.command);
};

export const getHostConnectSnippetCommands = (
  host: Pick<Host, "id">,
  snippets: Snippet[],
  valuesForSnippet?: SnippetVariableValuesProvider,
): string[] => snippets
  .filter((snippet) => shouldRunSnippetOnHostConnect(snippet, host.id))
  .map((snippet) => resolveSnippetAutomationCommand(snippet, valuesForSnippet?.(snippet) ?? {}))
  .filter((command): command is string => Boolean(command));

export const buildStartupCommandWithSnippetAutomation = ({
  hostStartupCommand,
  snippetCommands,
}: {
  hostStartupCommand?: string;
  snippetCommands: string[];
}): string | undefined => {
  const blocks = [
    normalizeCommandBlock(hostStartupCommand),
    ...snippetCommands.map(normalizeCommandBlock),
  ].filter((block): block is string => Boolean(block));
  if (blocks.length === 0) return undefined;
  return blocks.join("\n");
};

export const applySnippetStartupAutomation = (
  host: Host,
  snippets: Snippet[],
  options: { valuesForSnippet?: SnippetVariableValuesProvider } = {},
): Host => {
  const snippetCommands = getHostConnectSnippetCommands(host, snippets, options.valuesForSnippet);
  if (snippetCommands.length === 0) return host;
  const startupCommand = buildStartupCommandWithSnippetAutomation({
    hostStartupCommand: host.startupCommand,
    snippetCommands,
  });
  if (startupCommand === host.startupCommand) return host;
  return { ...host, startupCommand };
};
