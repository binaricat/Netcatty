import { useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";

export interface SftpBrowseConnectionLifecycle {
  generation: number;
  interactive: boolean;
}

export function useSftpBrowseConnectionLifecycle(
  interactive: boolean,
): MutableRefObject<SftpBrowseConnectionLifecycle> {
  const lifecycleRef = useRef<SftpBrowseConnectionLifecycle>({
    generation: 0,
    interactive,
  });

  useLayoutEffect(() => {
    if (lifecycleRef.current.interactive === interactive) return;
    lifecycleRef.current = {
      generation: lifecycleRef.current.generation + 1,
      interactive,
    };
  }, [interactive]);

  return lifecycleRef;
}
