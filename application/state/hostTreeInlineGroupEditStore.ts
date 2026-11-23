import { createExternalStore } from './createExternalStore';

export type HostTreeInlineGroupEdit = {
  groupPath: string;
  initialName: string;
  isNew: boolean;
  shouldScrollIntoView?: boolean;
};

const store = createExternalStore<HostTreeInlineGroupEdit | null>(null, {
  isEqual: () => false,
});

export const hostTreeInlineGroupEditStore = {
  getEdit: store.getSnapshot,
  startEdit: (edit: HostTreeInlineGroupEdit) => {
    store.setSnapshot({
      ...edit,
      shouldScrollIntoView: edit.isNew ? true : edit.shouldScrollIntoView,
    });
  },
  markScrollHandled: () => {
    const current = store.getSnapshot();
    if (!current?.shouldScrollIntoView) return;
    store.setSnapshot({ ...current, shouldScrollIntoView: false });
  },
  clear: () => {
    if (!store.getSnapshot()) return;
    store.setSnapshot(null);
  },
  subscribe: store.subscribe,
};

export const useHostTreeInlineGroupEdit = () => store.useStore();
