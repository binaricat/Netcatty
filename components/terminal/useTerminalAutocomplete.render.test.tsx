import test from "node:test";
import assert from "node:assert/strict";
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
