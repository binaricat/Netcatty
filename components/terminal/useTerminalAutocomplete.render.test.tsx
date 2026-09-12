import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useTerminalAutocomplete } from "./autocomplete/useTerminalAutocomplete.ts";

test("useTerminalAutocomplete can render before any autocomplete interaction", () => {
  function Probe() {
    const termRef = useRef(null);
    const containerRef = useRef(null);
    const autocomplete = useTerminalAutocomplete({
      termRef,
      containerRef,
      sessionId: "session-1",
      hostId: "host-1",
      hostOs: "linux",
      onAcceptText: () => {},
    });

    return <span>{typeof autocomplete.repositionPopup}</span>;
  }

  assert.doesNotThrow(() => {
    renderToStaticMarkup(<Probe />);
  });
});

test("network-device sessions skip live-preview writeToTerminal (#1193)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./autocomplete/useTerminalAutocomplete.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /livePreview: shouldWriteAutocompleteLivePreview\(rawSettings\.livePreview, isNetworkDevice\)/,
  );
  assert.match(
    source,
    /const renderPreviewSelection = useCallback\(\(index: number\) => \{\s*if \(!shouldWriteAutocompleteLivePreview\(\s*settingsRef\.current\.livePreview,\s*isNetworkDeviceRef\.current,\s*\)\) return;[\s\S]*?if \(seq\) writeToTerminal\(seq\);/,
  );
  assert.match(
    source,
    /const renderSubDirPath = useCallback\(\(level: number, entry: SubDirEntry\) => \{\s*if \(!shouldWriteAutocompleteLivePreview\(\s*settingsRef\.current\.livePreview,\s*isNetworkDeviceRef\.current,\s*\)\) return;[\s\S]*?if \(seq\) writeToTerminal\(seq\);/,
  );
});

test("repositionPopup pins the visible popup to the wrapped command start (#3061)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./autocomplete/useTerminalAutocomplete.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /resolveAutocompletePopupAnchorInViewport/);
  assert.match(source, /nextAutocompletePopupAnchorViewport/);
  assert.match(source, /if \(!stateRef\.current\.popupVisible \|\| stateRef\.current\.suggestions\.length === 0\) return;/);
});

test("mount effect re-arms disposedRef after dispose cleanup (HMR / StrictMode)", () => {
  // dispose() sets disposedRef=true on effect cleanup. Fast Refresh preserves
  // refs, so without resetting on mount, fetchSuggestions stays dead forever
  // while handleInput keeps scheduling — "fetch-scheduled" with no popup.
  const source = readFileSync(
    fileURLToPath(new URL("./autocomplete/useTerminalAutocomplete.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(source.includes("disposedRef.current = false;"));
  assert.ok(source.includes("return () => { dispose(); };"));
});
