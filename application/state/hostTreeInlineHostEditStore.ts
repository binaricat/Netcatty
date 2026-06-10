import { useSyncExternalStore } from 'react';

export type HostTreeInlineHostEdit = {
  hostId: string;
  initialName: string;
};

type Listener = () => void;

class HostTreeInlineHostEditStore {
  private edit: HostTreeInlineHostEdit | null = null;
  private listeners = new Set<Listener>();

  getEdit = () => this.edit;

  startEdit = (edit: HostTreeInlineHostEdit) => {
    this.edit = edit;
    this.listeners.forEach((listener) => listener());
  };

  clear = () => {
    if (!this.edit) return;
    this.edit = null;
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const hostTreeInlineHostEditStore = new HostTreeInlineHostEditStore();

export const useHostTreeInlineHostEdit = () => {
  return useSyncExternalStore(
    hostTreeInlineHostEditStore.subscribe,
    hostTreeInlineHostEditStore.getEdit,
    hostTreeInlineHostEditStore.getEdit,
  );
};
