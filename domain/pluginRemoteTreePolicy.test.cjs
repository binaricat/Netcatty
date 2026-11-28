"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePluginRemoteTree, validatePluginMutationBatch } = require("./pluginRemoteTreePolicy.cjs");
const text = (id, data) => ({ id, type: 3, data });
const element = (id, name, attributes = {}, children = []) => ({ id, type: 1, element: name, attributes, children });

test("normal HTML layout and styles can be represented without executable code", () => {
  const root = { children: [element("1", "section", { class: "card", style: "display:grid;grid-template-columns:1fr 2fr;gap:12px" }, [element("2", "h1", {}, [text("3", "Hello")]), element("4", "button", { type: "button" }, [text("5", "Click")])])] };
  assert.equal(validatePluginRemoteTree(root), true);
  assert.equal(validatePluginMutationBatch([[0, "~", root.children[0], 0], [3, "1", "class", "ready"], [2, "3", "Updated"]]), true);
});

test("untrusted content cannot introduce executable elements, URLs or dangerous properties", () => {
  const attacks = [
    element("1", "script"), element("1", "iframe"), element("1", "img", { src: "https://example.invalid" }),
    element("1", "a", { href: "javascript:alert(1)" }), element("1", "div", { onclick: "alert(1)" }),
    element("1", "input", { type: "file" }), element("1", "div", { style: "background:url(https://example.invalid)" }),
    element("1", "div", { style: "color:red;} body{color:red" }),
    element("1", "div", { __proto__: "bad" }, [text("1", "duplicate")]),
    { id: "1", type: 1, element: "div", attributes: {}, properties: { innerHTML: "bad" }, children: [] },
  ];
  for (const attack of attacks) assert.throws(() => validatePluginRemoteTree({ children: [attack] }), undefined, JSON.stringify(attack));
  assert.throws(() => validatePluginMutationBatch([[3, "1", "innerHTML", "<script>evil()</script>"]]));
  assert.throws(() => validatePluginMutationBatch([[3, "1", "__proto__", {}]]));
  assert.throws(() => validatePluginMutationBatch([[3, "1", "onclick", "evil()", 2]]));
  assert.throws(() => validatePluginMutationBatch([[3, "1", "class", "x", 3]]));
});

test("remote trees and mutation batches are bounded", () => {
  assert.throws(() => validatePluginRemoteTree({ children: Array.from({ length: 4097 }, (_, i) => text(`${i}`, "x")) }));
  let node = text("33", "x"); for (let i = 32; i >= 0; i--) node = element(`${i}`, "div", {}, [node]);
  assert.throws(() => validatePluginRemoteTree({ children: [node] }));
  assert.throws(() => validatePluginMutationBatch(Array.from({ length: 4097 }, () => [2, "1", "x"])));
  assert.throws(() => validatePluginMutationBatch([[2, "1", "x".repeat(131073)]]));
  assert.equal(validatePluginMutationBatch([[2, "1", "x".repeat(131072)]]), true);
});

test("declarative plugin widget markers and JSON props are strictly validated", () => {
  const validWidget = element("w1", "div", {
    "data-plugin-widget": "code-editor",
    "data-plugin-widget-props": JSON.stringify({ value: "SELECT 1;", language: "sql" }),
  });
  assert.equal(validatePluginRemoteTree({ children: [validWidget] }), true);
  const validChart = element("w-chart", "div", {
    "data-plugin-widget": "metric-chart",
    "data-plugin-widget-props": JSON.stringify({ variant: "sparkline", series: [{ id: "cpu", label: "CPU", points: [{ at: 1000, value: 42 }] }] }),
  });
  assert.equal(validatePluginRemoteTree({ children: [validChart] }), true);
  assert.throws(() => validatePluginRemoteTree({ children: [element("svg-attack", "svg")] }), /Forbidden view element/);
  assert.throws(() => validatePluginRemoteTree({ children: [element("w2", "div", { "data-plugin-widget": "iframe-hack" })] }), /widget/);
  assert.throws(() => validatePluginRemoteTree({ children: [element("w3", "div", { "data-plugin-widget": "data-grid", "data-plugin-widget-props": "{bad json" })] }), /JSON/);
  assert.throws(() => validatePluginRemoteTree({ children: [element("w4", "div", { "data-plugin-widget": "data-grid", "data-plugin-widget-props": "[]" })] }), /JSON object/);
  assert.throws(() => validatePluginRemoteTree({ children: [element("w5", "div", { "data-plugin-widget": "data-grid", "data-plugin-widget-props": "{\"__proto__\":{\"polluted\":true}}" })] }), /Forbidden key/);
});

test("void children are rejected in snapshots and mutation insertions", () => {
  for (const name of ["br", "hr", "img", "input"]) {
    const node = element("void", name);
    assert.equal(validatePluginRemoteTree({ children: [node] }), true);
    node.children.push(text("child", "invalid"));
    assert.throws(() => validatePluginRemoteTree({ children: [node] }), /Void view elements/);
    assert.throws(() => validatePluginMutationBatch([[0, "~", node, 0]]), /Void view elements/);
  }
  assert.throws(() => validatePluginRemoteTree({ children: [element("a", "textarea", {}, [element("b", "div")])] }), /Textarea/);
  assert.equal(validatePluginRemoteTree({ children: [element("a", "textarea", {}, [text("b", "Hello"), text("c", " world")])] }), true);
});
