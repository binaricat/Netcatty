import React, { Suspense, lazy } from "react";
import type { NotesManagerProps } from "./NotesManager";

const NotesManagerChunk = lazy(() =>
  import("./NotesManager").then((mod) => ({ default: mod.NotesManager })),
);

/**
 * Code-split wrapper so NotesManager (and its markdown/MDX parser tree)
 * is not parsed or retained in the initial startup bundle until opened.
 */
export const LazyNotesManager: React.FC<NotesManagerProps> = (props) => (
  <Suspense fallback={null}>
    <NotesManagerChunk {...props} />
  </Suspense>
);
