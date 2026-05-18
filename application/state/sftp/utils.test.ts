import test from "node:test";
import assert from "node:assert/strict";

import { isConcreteTransferTargetPath } from "./utils";

test("concrete transfer target paths exclude temporary placeholders", () => {
  assert.equal(isConcreteTransferTargetPath({ targetPath: "/Users/alice/Downloads/report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "C:\\Users\\alice\\Downloads\\report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "(temp)" }), false);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "   " }), false);
});
