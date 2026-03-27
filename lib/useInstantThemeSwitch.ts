import { RefObject, useEffect } from "react";

export const useInstantThemeSwitch = <T extends HTMLElement>(
  rootRef: RefObject<T | null>,
) => {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const html = document.documentElement;
    let previousIsDark = html.classList.contains("dark");
    let markedNode: HTMLElement | null = rootRef.current;
    let releaseFrame = 0;
    let cleanupFrame = 0;

    const cancelPendingFrames = () => {
      if (releaseFrame) {
        cancelAnimationFrame(releaseFrame);
        releaseFrame = 0;
      }
      if (cleanupFrame) {
        cancelAnimationFrame(cleanupFrame);
        cleanupFrame = 0;
      }
    };

    const clearMarker = (node: HTMLElement | null) => {
      node?.removeAttribute("data-instant-theme-switch");
    };

    const freezeTransitions = () => {
      const node = rootRef.current;
      if (!node) return;

      cancelPendingFrames();
      markedNode = node;
      node.setAttribute("data-instant-theme-switch", "true");

      // Force layout so subsequent token updates land in a transition-free frame.
      void node.offsetHeight;

      releaseFrame = requestAnimationFrame(() => {
        cleanupFrame = requestAnimationFrame(() => {
          clearMarker(node);
          if (markedNode !== node) clearMarker(markedNode);
          releaseFrame = 0;
          cleanupFrame = 0;
        });
      });
    };

    const observer = new MutationObserver(() => {
      const nextIsDark = html.classList.contains("dark");
      if (nextIsDark === previousIsDark) return;
      previousIsDark = nextIsDark;
      freezeTransitions();
    });

    observer.observe(html, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
      cancelPendingFrames();
      clearMarker(markedNode);
    };
  }, [rootRef]);
};
