import test from "node:test";
import assert from "node:assert/strict";

import {
  applySnippetVariables,
  parseSnippetVariables,
  previewSnippetCommand,
  snippetHasVariables,
} from "./snippetVariables.ts";

test("parseSnippetVariables finds all vars after snippetHasVariables (shared-regex lastIndex)", () => {
  const command = "echo '{{test}}'\necho '{{test2}}'";
  assert.equal(snippetHasVariables(command), true);
  assert.deepEqual(parseSnippetVariables(command).map((v) => v.name), ["test", "test2"]);
});

test("parseSnippetVariables returns empty for plain command", () => {
  assert.deepEqual(parseSnippetVariables("ls -la"), []);
  assert.equal(snippetHasVariables("ls -la"), false);
});

test("parseSnippetVariables dedupes by first occurrence order", () => {
  assert.deepEqual(parseSnippetVariables("echo {{a}} and {{b}} and {{a}}"), [
    { name: "a" },
    { name: "b" },
  ]);
});

test("parseSnippetVariables reads default after colon", () => {
  assert.deepEqual(parseSnippetVariables("fallocate -l {{内存大小:4}}G"), [
    { name: "内存大小", defaultValue: "4" },
  ]);
});

test("parseSnippetVariables ignores Docker Go template field literals", () => {
  const command = "ls -lh $(docker inspect --format='{{.LogPath}}' moviepilot)";

  assert.equal(snippetHasVariables(command), false);
  assert.deepEqual(parseSnippetVariables(command), []);
});

test("parseSnippetVariables ignores Docker Go template field literals with trim markers", () => {
  const command = "ls -lh $(docker inspect --format='{{- .LogPath -}}' moviepilot)";

  assert.equal(snippetHasVariables(command), false);
  assert.deepEqual(parseSnippetVariables(command), []);
});

test("applySnippetVariables preserves Docker Go template field literals", () => {
  const command = "ls -lh $(docker inspect --format='{{.LogPath}}' moviepilot)";
  const result = applySnippetVariables(command, {});

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, command);
});

test("applySnippetVariables preserves Docker Go template field literals with trim markers", () => {
  const command = "ls -lh $(docker inspect --format='{{- .LogPath -}}' moviepilot)";
  const result = applySnippetVariables(command, {});

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, command);
});

test("applySnippetVariables preserves Docker Go template action blocks", () => {
  const command = "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' moviepilot";
  const result = applySnippetVariables(command, {});

  assert.equal(snippetHasVariables(command), false);
  assert.deepEqual(parseSnippetVariables(command), []);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, command);
});

test("applySnippetVariables preserves Docker Go template assignment action blocks", () => {
  const command = "docker inspect --format='{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}' moviepilot";
  const result = applySnippetVariables(command, {});

  assert.equal(snippetHasVariables(command), false);
  assert.deepEqual(parseSnippetVariables(command), []);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, command);
});

test("applySnippetVariables preserves Docker Go template assigned variables", () => {
  const cases = [
    "docker inspect --format='{{$p := .LogPath}}{{$p}}' moviepilot",
    "docker inspect --format='{{$p := .LogPath}}{{printf \"%s\" $p}}' moviepilot",
    "docker inspect --format='{{$p := .LogPath}}{{if $p}}{{$p}}{{end}}' moviepilot",
    "docker inspect --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}}{{end}}' moviepilot",
  ];

  for (const command of cases) {
    const result = applySnippetVariables(command, {});

    assert.equal(snippetHasVariables(command), false);
    assert.deepEqual(parseSnippetVariables(command), []);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.command, command);
  }
});

test("applySnippetVariables preserves Docker Go template helper actions", () => {
  const cases = [
    "docker inspect --format='{{json .}}' moviepilot",
    "docker inspect --format='{{printf \"%s\" .}}' moviepilot",
    "docker inspect --format='{{println .}}' moviepilot",
  ];

  for (const command of cases) {
    const result = applySnippetVariables(command, {});

    assert.equal(snippetHasVariables(command), false);
    assert.deepEqual(parseSnippetVariables(command), []);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.command, command);
  }
});

test("applySnippetVariables can mix script variables with Docker Go template field literals", () => {
  const result = applySnippetVariables(
    "ls -lh $(docker inspect --format='{{.LogPath}}' {{container:moviepilot}})",
    {},
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.command,
      "ls -lh $(docker inspect --format='{{.LogPath}}' moviepilot)",
    );
  }
});

test("applySnippetVariables can mix script variables with Docker Go template action blocks", () => {
  const result = applySnippetVariables(
    "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' {{container:moviepilot}}",
    {},
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.command,
      "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' moviepilot",
    );
  }
});

test("snippetHasVariables detects script variables after Docker Go template field literals", () => {
  assert.equal(
    snippetHasVariables("docker inspect --format='{{.LogPath}}' {{container}}"),
    true,
  );
});

test("parseSnippetVariables keeps regular variables named like Go template controls outside Go template context", () => {
  const result = applySnippetVariables("echo {{end}}", { end: "done" });

  assert.equal(snippetHasVariables("echo {{end}}"), true);
  assert.deepEqual(parseSnippetVariables("echo {{end}}"), [{ name: "end" }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, "echo done");
});

test("applySnippetVariables keeps regular variables named like Go template controls near Go template context", () => {
  const result = applySnippetVariables(
    "docker inspect --format='{{.LogPath}}' {{end:done}}",
    {},
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.command, "docker inspect --format='{{.LogPath}}' done");
  }
});

test("applySnippetVariables keeps required variables named like Go template controls near Go template context", () => {
  const result = applySnippetVariables(
    "docker inspect --format='{{.LogPath}}' {{end}}",
    { end: "done" },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.command, "docker inspect --format='{{.LogPath}}' done");
  }
});

test("applySnippetVariables does not replace Go template actions when a script variable has the same name", () => {
  const command = "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' {{end:done}}";
  const result = applySnippetVariables(command, {});

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.command,
      "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' done",
    );
  }
});

test("previewSnippetCommand does not replace Go template actions when a script variable has the same name", () => {
  assert.equal(
    previewSnippetCommand(
      "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' {{end:done}}",
      {},
    ),
    "docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' done",
  );
});

test("applySnippetVariables replaces all occurrences", () => {
  const result = applySnippetVariables(
    "fallocate -l {{内存大小:4}}G\nswapon {{内存大小:4}}",
    { 内存大小: "8" },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.command, "fallocate -l 8G\nswapon 8");
  }
});

test("applySnippetVariables uses default when value empty", () => {
  const result = applySnippetVariables("size {{n:2}}", { n: "" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, "size 2");
});

test("applySnippetVariables reports missing required vars", () => {
  const result = applySnippetVariables("echo {{name}}", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ["name"]);
});

test("applySnippetVariables passes through command without variables", () => {
  const result = applySnippetVariables("uptime", { x: "1" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, "uptime");
});

test("previewSnippetCommand keeps placeholder for unfilled required", () => {
  assert.equal(
    previewSnippetCommand("echo {{a}}", {}),
    "echo {{a}}",
  );
});

test("previewSnippetCommand shows resolved values", () => {
  assert.equal(
    previewSnippetCommand("echo {{a:hi}}", {}),
    "echo hi",
  );
});
