import type { PluginAIHostModelEvent, PluginAIHostResult } from '@netcatty/plugin-contract';
import { createPluginModelAdapter } from './modelInvocationAdapter';
import type { ProviderConfig } from '../types';

// Trusted application renderer only. This runtime is never loaded by a plugin.
export interface HostSelectedSource {
  key: string;
  scope: 'workspace' | 'tab' | 'session' | 'host' | 'note';
  title: string;
  version: string;
  readText: () => string | Promise<string>;
  isCurrent: () => boolean | Promise<boolean>;
}
type Model = ReturnType<typeof createPluginModelAdapter>;
type Iterator = ReturnType<Model['invoke']>;
type Owned<T> = T & { runtimeId: string };

export function createTrustedPluginAIHostRuntime(options: {
  getModel: () => { config: ProviderConfig; label: string; revision: string } | null;
  prepareModel: (revision: string) => Promise<void>;
  chooseSelected: (signal: AbortSignal, runtimeId: string) => Promise<HostSelectedSource[]>;
  isActive: () => boolean;
}) {
  const models = new Map<string, Owned<{ model: Model }>>();
  const selections = new Set<{ runtimeId: string; active: boolean }>();
  const turns = new Map<string, Owned<{ iterator: Iterator; controller: AbortController; reading: boolean }>>();
  const sources = new Map<string, Owned<{ source: HostSelectedSource }>>();
  let closed = false;
  const assertActive = () => { if (closed || !options.isActive()) throw Error('Host is unavailable'); };
  const owned = <T extends { runtimeId: string }>(collection: Map<string, T>, key: unknown, runtimeId: string): T => {
    const item = typeof key === 'string' ? collection.get(key) : undefined;
    if (!item || item.runtimeId !== runtimeId) throw Error('Host handle is unavailable');
    return item;
  };
  const cancel = (handle: string) => {
    const turn = turns.get(handle);
    if (!turn) return;
    turns.delete(handle); turn.controller.abort();
    void turn.iterator.return(undefined).catch(() => {});
  };
  const releaseRuntime = (runtimeId: string) => {
    for (const selection of selections) if (selection.runtimeId === runtimeId) { selection.active = false; selections.delete(selection); }
    for (const [handle, turn] of turns) if (turn.runtimeId === runtimeId) cancel(handle);
    for (const [handle, model] of models) if (model.runtimeId === runtimeId) models.delete(handle);
    for (const [handle, source] of sources) if (source.runtimeId === runtimeId) sources.delete(handle);
  };
  return {
    // The main-process bridge supplies canonical envelopes, validates the sender,
    // and binds each request to its current window and plugin runtime.
    async handle(kind: string, payload: Record<string, unknown>, runtimeId: string, signal: AbortSignal = new AbortController().signal): Promise<PluginAIHostResult> {
      if (kind === 'runtime.release') { releaseRuntime(runtimeId); return { ok: true }; }
      assertActive();
      if (kind === 'model.select') {
        const selected = options.getModel();
        if (!selected || !selected.config.enabled || !selected.config.defaultModel) throw Error('Choose a configured model first');
        if (models.size + selections.size >= 32) throw Error('Model handle limit reached');
        const selection = { runtimeId, active: true };
        selections.add(selection);
        try {
          await options.prepareModel(selected.revision);
          signal.throwIfAborted(); assertActive();
          if (!selection.active || options.getModel()?.revision !== selected.revision) throw Error('Selected model changed');
          const handle = crypto.randomUUID();
          const model = createPluginModelAdapter({ config: selected.config, label: selected.label, transportTag: runtimeId,
            isCurrent: () => !closed && options.isActive() && options.getModel()?.revision === selected.revision });
          models.set(handle, { runtimeId, model });
          return { hostHandle: handle, label: selected.label };
        } finally { selections.delete(selection); }
      }
      if (kind === 'model.release') { owned(models, payload.hostHandle, runtimeId); models.delete(String(payload.hostHandle)); return { ok: true }; }
      if (kind === 'model.current') return { current: await owned(models, payload.hostHandle, runtimeId).model.isCurrent() };
      if (kind === 'model.start') {
        const { model } = owned(models, payload.hostHandle, runtimeId);
        if (!await model.isCurrent()) throw Error('Selected model changed');
        if (turns.size >= 32 || typeof payload.prompt !== 'string' || new TextEncoder().encode(payload.prompt).byteLength > 16_384
          || !Array.isArray(payload.contexts) || payload.contexts.length > 4 || payload.contexts.some((text) => typeof text !== 'string')
          || !Number.isInteger(payload.maxOutputTokens) || Number(payload.maxOutputTokens) < 1 || Number(payload.maxOutputTokens) > 2048
          || !Number.isInteger(payload.maxChunkBytes) || Number(payload.maxChunkBytes) < 4 || Number(payload.maxChunkBytes) > 4096
          || payload.contexts.reduce((bytes, text) => bytes + new TextEncoder().encode(text).byteLength, new TextEncoder().encode(payload.prompt).byteLength) > 16_384) {
          throw Error('Model input exceeds its limit');
        }
        assertActive();
        const controller = new AbortController(); const handle = crypto.randomUUID();
        const iterator = model.invoke({ prompt: payload.prompt, contexts: payload.contexts,
          maxOutputTokens: Number(payload.maxOutputTokens), maxChunkBytes: Number(payload.maxChunkBytes), signal: controller.signal });
        turns.set(handle, { runtimeId, iterator, controller, reading: false });
        return { hostHandle: handle };
      }
      if (kind === 'model.next') {
        const turn = owned(turns, payload.hostHandle, runtimeId);
        if (turn.reading) throw Error('Model read already pending');
        turn.reading = true;
        const abort = () => cancel(String(payload.hostHandle));
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          const result = await turn.iterator.next();
          assertActive();
          turn.controller.signal.throwIfAborted();
          if (turns.get(String(payload.hostHandle)) !== turn) throw Error('Model turn ended');
          if (result.done) { turns.delete(String(payload.hostHandle)); return { done: true }; }
          // Unknown usage values are omitted before canonical JSON validation.
          if (!result.value || typeof result.value !== 'object') throw Error('Invalid model stream event');
          const value = result.value as Record<string, unknown>;
          let event: PluginAIHostModelEvent;
          if (value.kind === 'text' && typeof value.text === 'string') event = { kind: 'text', text: value.text };
          else if (value.kind === 'usage') {
            event = { kind: 'usage' };
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
              const tokens = value[key];
              if (tokens !== undefined) {
                if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw Error('Invalid model usage');
                event[key] = tokens;
              }
            }
          } else throw Error('Unsupported model event');
          return { done: false, event };
        } catch { cancel(String(payload.hostHandle)); throw Error('Model invocation failed'); }
        finally { turn.reading = false; signal.removeEventListener('abort', abort); }
      }
      if (kind === 'model.stop') { owned(turns, payload.hostHandle, runtimeId); cancel(String(payload.hostHandle)); return { ok: true }; }
      if (kind === 'context.select') {
        const selected = await options.chooseSelected(signal, runtimeId);
        signal.throwIfAborted();
        assertActive();
        if (selected.length > 5 || new Set(selected.map((source) => source.scope)).size !== selected.length) throw Error('Selected scope limit reached');
        for (const [handle, source] of sources) if (source.runtimeId === runtimeId) sources.delete(handle);
        if (sources.size + selected.length > 128) throw Error('Selected source limit reached');
        const items = [];
        for (const source of selected) {
          if (!await source.isCurrent()) throw Error('Selected context changed');
          const hostHandle = crypto.randomUUID(); sources.set(hostHandle, { runtimeId, source });
          items.push({ hostHandle, scope: source.scope, title: source.title, version: source.version });
        }
        return { items };
      }
      if (kind === 'context.current' || kind === 'context.read') {
        const { source } = owned(sources, payload.hostHandle, runtimeId);
        const current = payload.version === source.version && await source.isCurrent();
        assertActive();
        if (kind === 'context.current') return { current };
        if (!current) throw Error('Selected context changed');
        const text = await source.readText();
        assertActive();
        if (!await source.isCurrent() || typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 16_384) throw Error('Selected text is unavailable');
        return { text };
      }
      throw Error('Unsupported host operation');
    },
    releaseRuntime,
    shutdown() { closed = true; for (const selection of selections) selection.active = false; selections.clear(); for (const handle of [...turns.keys()]) cancel(handle); models.clear(); sources.clear(); },
  };
}
