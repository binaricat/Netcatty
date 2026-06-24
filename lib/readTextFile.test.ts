import assert from "node:assert/strict";
import test from "node:test";
import { readTextFile } from "./readTextFile";

test("readTextFile decodes UTF-8 text without BOM", async () => {
  const file = new File(["hello"], "note.md", { type: "text/plain" });
  assert.equal(await readTextFile(file), "hello");
});

test("readTextFile strips UTF-8 BOM", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
  const file = new File([bytes], "note.md", { type: "text/plain" });
  assert.equal(await readTextFile(file), "hello");
});

test("readTextFile decodes UTF-16 LE with BOM", async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  const file = new File([bytes], "note.md", { type: "text/plain" });
  assert.equal(await readTextFile(file), "hi");
});

test("readTextFile decodes UTF-16 BE with BOM", async () => {
  const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  const file = new File([bytes], "note.md", { type: "text/plain" });
  assert.equal(await readTextFile(file), "hi");
});
