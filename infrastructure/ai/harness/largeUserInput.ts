import type { ToolOutputStore } from './toolOutputStore';

const LARGE_USER_INPUT_THRESHOLD_CHARS = 25_000;
const LARGE_USER_INPUT_HEAD_CHARS = 12_000;
const LARGE_USER_INPUT_TAIL_CHARS = 4_000;

const handlesByStore = new WeakMap<ToolOutputStore, Map<string, string>>();

function hashInput(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function getStableHandleId(
  input: string,
  chatSessionId: string,
  toolOutputStore: ToolOutputStore,
): string {
  const handles = handlesByStore.get(toolOutputStore) ?? new Map<string, string>();
  handlesByStore.set(toolOutputStore, handles);
  const key = `${chatSessionId}:${input.length}:${hashInput(input)}`;
  const existingId = handles.get(key);
  if (existingId && toolOutputStore.get(existingId, chatSessionId)) return existingId;

  const handleId = toolOutputStore.store({
    chatSessionId,
    capabilityId: 'user.input',
    content: input,
  }).id;
  handles.set(key, handleId);
  return handleId;
}

export function fitLargeUserInputForModel(
  input: string,
  chatSessionId: string,
  toolOutputStore: ToolOutputStore,
): string {
  if (input.length <= LARGE_USER_INPUT_THRESHOLD_CHARS) return input;
  const handleId = getStableHandleId(input, chatSessionId, toolOutputStore);
  return [
    input.slice(0, LARGE_USER_INPUT_HEAD_CHARS),
    `\n\n[... large user input moved to saved output: ${input.length} chars, handleId=${handleId}. Use tool_output_read with range or search for omitted details ...]\n\n`,
    input.slice(-LARGE_USER_INPUT_TAIL_CHARS),
  ].join('');
}
