import { RemoteReceiver } from '@remote-dom/core/receivers';
import { validatePluginMutationBatch, validatePluginRemoteTree } from '@/domain/pluginRemoteTreePolicy.cjs';

type WireNode = { id: string; type: 3 | 8; data: string } | {
  id: string; type: 1; element: string; attributes: Record<string, string>; children: WireNode[];
};
type WireTree = { children: WireNode[] };

/** Data-only staging area: untrusted changes are never applied directly to the host DOM. */
export function createPluginRemoteTree() {
  const receiver = new RemoteReceiver();
  let current: WireTree = { children: [] };
  let failed = false;
  const project = (node: unknown): WireNode => {
    const value = node as { id: string; type: number; data?: string; element?: string; attributes?: Record<string, string>; children?: unknown[] };
    if (value.type === 3 || value.type === 8) return { id: value.id, type: value.type, data: value.data ?? '' };
    return { id: value.id, type: 1, element: value.element ?? '', attributes: Object.fromEntries(Object.entries(value.attributes ?? {}).filter(([, attribute]) => attribute !== null)), children: (value.children ?? []).map(project) };
  };
  return {
    apply(input: unknown): WireTree {
      if (failed) throw new Error('Plugin view has been closed after an invalid update');
      try {
        validatePluginMutationBatch(input);
        // Ordinary DOM attribute mutations do not specify a channel. RemoteReceiver
        // defaults those to properties, so explicitly mark them as attributes.
        const batch = (input as unknown[][]).map((record) => record[0] === 3 && record.length === 4 ? [...record, 2] : record);
        receiver.connection.mutate(batch as unknown as Parameters<typeof receiver.connection.mutate>[0]);
        const next = { children: receiver.root.children.map(project) };
        validatePluginRemoteTree(next);
        current = next;
        return next;
      } catch (error) {
        failed = true;
        current = { children: [] };
        throw error;
      }
    },
    snapshot(): WireTree { return current; },
    isFailed(): boolean { return failed; },
  };
}
