"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("public preparation accepts only its exact documented endpoint and private preparation stays private", async () => {
  const { prepareRfamExample } = await import("./prepare.mjs");
  const { prepareDatabaseExample } = await import("../database-minimal/prepare.mjs");
  for (const endpoint of ["tcp://example.org:4497", "tcp://mysql-rfam-public.ebi.ac.uk:3306",
    "tcp://mysql-rfam-public.ebi.ac.uk:4497/", "tls://mysql-rfam-public.ebi.ac.uk:4497",
    "tcp://127.0.0.1:4497", "tcp://10.0.0.9:4497"]) {
    await assert.rejects(prepareRfamExample(endpoint, "/unused/output.ncpkg"), /exact Rfam/u);
  }
  await assert.rejects(prepareDatabaseExample("tcp://mysql-rfam-public.ebi.ac.uk:4497", "/unused/output.ncpkg"), /private IPv4/u);
});
