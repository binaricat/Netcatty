import assert from "node:assert/strict";
import test from "node:test";

import { getSessionLogInitialLine } from "./sessionLogInitialLine.ts";

const makeTerm = (rows: Array<{ text: string; isWrapped?: boolean }>, cursorY: number, cursorX: number) => ({
  buffer: {
    active: {
      baseY: 0,
      cursorY,
      cursorX,
      getLine: (line: number) => {
        const row = rows[line];
        if (!row) return undefined;
        return {
          isWrapped: row.isWrapped,
          translateToString: () => row.text,
        };
      },
    },
  },
});

test("getSessionLogInitialLine captures the current prompt and typed command", () => {
  const term = makeTerm([
    { text: "root@MyNAS:~# show vlan" },
  ], 0, "root@MyNAS:~# show vlan".length);

  assert.equal(getSessionLogInitialLine(term), "root@MyNAS:~# show vlan");
});

test("getSessionLogInitialLine falls back to nearest trusted prompt line", () => {
  const term = makeTerm([
    { text: "root@MyNAS:~# " },
    { text: "command output" },
  ], 1, "command output".length);

  assert.equal(getSessionLogInitialLine(term), "root@MyNAS:~# ");
});
