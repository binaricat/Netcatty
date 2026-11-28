"use strict";
/* global TextEncoder */
const { validatePluginInlineStyle } = require("./pluginViewStylePolicy.cjs");

// These are HTML primitives, not a fixed design-system component catalogue.
// Active elements, custom elements and URL attributes need separate authority.
const ELEMENTS = new Set(["form", "img", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "li", "dl", "dt", "dd", "strong", "em", "small", "b", "i", "code", "pre", "blockquote", "br", "hr", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "button", "input", "textarea", "label", "select", "option", "fieldset", "legend", "progress", "details", "summary"]);
const VOID_ELEMENTS = new Set(["br", "hr", "img", "input"]);
const ATTRIBUTES = new Set(["lang", "dir", "anchor", "src", "alt", "width", "height", "class", "id", "title", "role", "style", "name", "placeholder", "value", "checked", "disabled", "readonly", "required", "multiple", "selected", "type", "for", "tabindex", "min", "max", "step", "minlength", "maxlength", "rows", "cols", "colspan", "rowspan", "scope", "open", "autocomplete"]);
const INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password", "checkbox", "radio", "range", "date", "time", "datetime-local", "color", "button"]);
const ALLOWED_WIDGETS = new Set(["code-editor", "data-grid", "split-pane", "er-canvas", "metric-chart"]);
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NAME = /^[a-zA-Z0-9_-]{1,80}$/u;
const MAX_NODES = 4096;
const MAX_DEPTH = 32;
const MAX_VALUE = 131072;
const MAX_WIDGET_PROPS_VALUE = 768 * 1024;
const MAX_TEXT_SIZE = 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_WIDGET_PROPS_DEPTH = 12;
function validateId(value, root = false) {
  if (typeof value !== "string" || (root && value === "~" ? false : !NAME.test(value))) throw new TypeError("Invalid view node ID");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validateSafeJsonValue(value, depth = 0) {
  if (depth > MAX_WIDGET_PROPS_DEPTH) throw new TypeError("Widget props exceed depth limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Invalid numeric value in widget props");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateSafeJsonValue(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(k)) throw new TypeError("Forbidden key in widget props");
      validateSafeJsonValue(v, depth + 1);
    }
    return;
  }
  throw new TypeError("Invalid value in widget props");
}
function validateWidgetProps(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new TypeError("Invalid plugin widget props JSON"); }
  if (!record(parsed)) throw new TypeError("Plugin widget props must be a JSON object");
  validateSafeJsonValue(parsed, 0);
}
function validateAttribute(element, name, value) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(name) || (!ATTRIBUTES.has(name) && !/^aria-[a-z0-9-]+$/u.test(name) && !/^data-[a-z0-9-]+$/u.test(name))) throw new TypeError("Forbidden view attribute");
  if (value === null) return;
  const maxLen = name === "data-plugin-widget-props" ? MAX_WIDGET_PROPS_VALUE : MAX_VALUE;
  if (typeof value !== "string" || value.length > maxLen || value.includes("\0")) throw new TypeError("Invalid view attribute value");
  if (name === "data-plugin-widget" && !ALLOWED_WIDGETS.has(value)) throw new TypeError("Forbidden plugin widget type");
  if (name === "data-plugin-widget-props") validateWidgetProps(value);
  if (name === "type" && element === "input" && !INPUT_TYPES.has(value.toLowerCase())) throw new TypeError("Forbidden input type");
  if (name === "type" && element === "button" && !["button", "reset", "submit"].includes(value.toLowerCase())) throw new TypeError("Forbidden button type");
  if (name === "src" && (!/^asset:[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,255}$/.test(value) || value.slice(6).split("/").some((part) => !part || part === "." || part === ".."))) throw new TypeError("Only package images are permitted");
  if (name === "style") validatePluginInlineStyle(value);
}
/** Validate a complete, data-only snapshot before touching a host DOM. */
function validatePluginRemoteTree(root) {
  if (!record(root) || !Array.isArray(root.children) || Object.keys(root).some((key) => key !== "children")) throw new TypeError("Invalid view root");
  const ids = new Set(); let count = 0; let textSize = 0;
  const visit = (node, depth) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH || !record(node)) throw new TypeError("View tree exceeds limits");
    validateId(node.id); if (ids.has(node.id)) throw new TypeError("Duplicate view node"); ids.add(node.id);
    if (node.type === 3 || node.type === 8) {
      if (Object.keys(node).some((key) => !["id", "type", "data"].includes(key)) || typeof node.data !== "string" || node.data.length > MAX_VALUE) throw new TypeError("Invalid view text");
      textSize += node.data.length; if (textSize > MAX_TEXT_SIZE) throw new TypeError("View text exceeds limits"); return;
    }
    if (node.type !== 1 || typeof node.element !== "string" || !ELEMENTS.has(node.element)
      || !Array.isArray(node.children) || !record(node.attributes)
      || Object.keys(node).some((key) => !["id", "type", "element", "attributes", "children"].includes(key))) throw new TypeError("Forbidden view element");
    if (VOID_ELEMENTS.has(node.element) && node.children.length) throw new TypeError("Void view elements cannot have children");
    if (node.element === "textarea" && node.children.some((child) => !record(child) || ![3, 8].includes(child.type))) throw new TypeError("Textarea only accepts text");
    const attributes = Object.entries(node.attributes);
    if (attributes.length > 64) throw new TypeError("Too many view attributes");
    for (const [name, value] of attributes) {
      validateAttribute(node.element, name, value);
      textSize += name.length + (value?.length ?? 0);
      if (textSize > MAX_TEXT_SIZE) throw new TypeError("View data exceeds limits");
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const child of root.children) visit(child, 1);
  return true;
}
/** Preflight mutation size and shape before applying to an isolated data tree. */
function validatePluginMutationBatch(batch) {
  if (!Array.isArray(batch) || batch.length > MAX_RECORDS) throw new TypeError("Invalid view mutations");
  let size;
  try { size = new TextEncoder().encode(JSON.stringify(batch)).byteLength; } catch { throw new TypeError("Invalid view mutations"); }
  if (size > MAX_BATCH_BYTES) throw new TypeError("View mutations exceed limits");
  for (const item of batch) {
    if (!Array.isArray(item) || ![0, 1, 2, 3].includes(item[0])) throw new TypeError("Invalid view mutation");
    validateId(item[1], true);
    if (item[0] === 0) {
      if (item.length !== 4 || !Number.isSafeInteger(item[3]) || item[3] < 0 || item[3] > MAX_NODES) throw new TypeError("Invalid insertion");
      validatePluginRemoteTree({ children: [item[2]] });
    } else if (item[0] === 1) {
      if (item.length !== 3 || !Number.isSafeInteger(item[2]) || item[2] < 0 || item[2] > MAX_NODES) throw new TypeError("Invalid removal");
    } else if (item[0] === 2) {
      if (item.length !== 3 || typeof item[2] !== "string" || item[2].length > MAX_VALUE) throw new TypeError("Invalid text update");
    } else if (item.length < 4 || item.length > 5 || (item[4] !== undefined && item[4] !== 2)) {
      throw new TypeError("Only attribute updates are permitted");
    } else validateAttribute("", item[2], item[3]);
  }
  return true;
}
module.exports = {
  validatePluginRemoteTree,
  validatePluginMutationBatch,
  validateAttribute,
  ELEMENTS,
  ALLOWED_WIDGETS,
  MAX_NODES,
  MAX_DEPTH,
  MAX_VALUE,
  MAX_WIDGET_PROPS_VALUE,
  MAX_TEXT_SIZE,
  MAX_RECORDS,
  MAX_BATCH_BYTES,
};
