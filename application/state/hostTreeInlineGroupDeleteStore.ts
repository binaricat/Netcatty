import { createExternalStore } from './createExternalStore';

const store = createExternalStore<string | null>(null, {
  isEqual: () => false,
});

export const hostTreeInlineGroupDeleteStore = {
  getTargetPath: store.getSnapshot,
  open: (groupPath: string) => store.setSnapshot(groupPath),
  close: () => {
    if (!store.getSnapshot()) return;
    store.setSnapshot(null);
  },
  subscribe: store.subscribe,
};

export const useHostTreeInlineGroupDeleteTarget = () => store.useStore();
