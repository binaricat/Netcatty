import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostNotesIndicator } from "./HostNotesIndicator";

test("notes indicators distinguish groups from hosts and hide empty notes", () => {
  assert.match(renderToStaticMarkup(<HostNotesIndicator notes="Host" />), /aria-label="Host notes"/);
  assert.match(renderToStaticMarkup(<HostNotesIndicator notes="# Project" label="Group notes" />), /aria-label="Group notes"/);
  assert.equal(renderToStaticMarkup(<HostNotesIndicator notes="  " label="Group notes" />), "");
});
