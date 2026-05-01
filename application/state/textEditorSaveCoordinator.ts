export interface TextEditorSaveCoordinator {
  save(content: string): Promise<boolean>;
  isSaving(): boolean;
  reset(): void;
}

export interface TextEditorSaveCoordinatorOptions {
  onSave: (content: string) => Promise<void>;
  onSaveStart?: (content: string) => void;
  onSaveSuccess?: (content: string) => void;
  onSaveError?: (error: unknown) => void;
  onSavingChange?: (saving: boolean) => void;
}

interface InFlightSave {
  content: string;
  promise: Promise<boolean>;
}

export const createTextEditorSaveCoordinator = (
  options: TextEditorSaveCoordinatorOptions,
): TextEditorSaveCoordinator => {
  let inFlight: InFlightSave | null = null;
  let generation = 0;

  const notifySavingChange = () => {
    options.onSavingChange?.(inFlight !== null);
  };

  const startSave = (content: string): Promise<boolean> => {
    const saveGeneration = generation;
    options.onSaveStart?.(content);

    const promise = (async () => {
      try {
        await options.onSave(content);
        if (saveGeneration !== generation) {
          return false;
        }
        if (saveGeneration === generation) {
          options.onSaveSuccess?.(content);
        }
        return true;
      } catch (error) {
        if (saveGeneration !== generation) {
          return false;
        }
        if (saveGeneration === generation) {
          options.onSaveError?.(error);
        }
        return false;
      }
    })();

    const entry = { content, promise };
    inFlight = entry;
    notifySavingChange();
    void promise.finally(() => {
      if (inFlight === entry) {
        inFlight = null;
        notifySavingChange();
      }
    });
    return promise;
  };

  const save = async (content: string): Promise<boolean> => {
    const current = inFlight;
    if (current) {
      const waitGeneration = generation;
      const ok = await current.promise;
      if (waitGeneration !== generation) return false;
      if (!ok || current.content === content) return ok;
      return save(content);
    }
    return startSave(content);
  };

  return {
    save,
    isSaving: () => inFlight !== null,
    reset: () => {
      generation += 1;
      if (inFlight) {
        inFlight = null;
        notifySavingChange();
      }
    },
  };
};
