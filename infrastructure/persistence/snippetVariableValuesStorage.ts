import { STORAGE_KEY_SNIPPET_VAR_VALUES } from '../config/storageKeys';
import { localStorageAdapter } from './localStorageAdapter';

export type SnippetVariableValuesStore = Record<string, Record<string, string>>;

export function readSnippetVariableValuesStore(): SnippetVariableValuesStore {
  return localStorageAdapter.read<SnippetVariableValuesStore>(STORAGE_KEY_SNIPPET_VAR_VALUES) ?? {};
}

export function readSnippetVariableValuesForSnippet(snippetId: string): Record<string, string> {
  return readSnippetVariableValuesStore()[snippetId] ?? {};
}

export function saveSnippetVariableValues(
  snippetId: string,
  values: Record<string, string>,
): void {
  const store = readSnippetVariableValuesStore();
  store[snippetId] = { ...store[snippetId], ...values };
  localStorageAdapter.write(STORAGE_KEY_SNIPPET_VAR_VALUES, store);
}
