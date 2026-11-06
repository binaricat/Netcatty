"use strict";

// Plugin styles are untrusted: they are never inserted before this check.
const cssTree = require("css-tree");
const MAX_CSS_LENGTH = 64 * 1024;
const MAX_AST_NODES = 20_000;
const ALLOWED_AT_RULES = new Set(["media", "supports", "container", "keyframes", "-webkit-keyframes", "layer"]);
const ALLOWED_FUNCTIONS = new Set([
  "var", "calc", "min", "max", "clamp", "abs", "sign", "round", "mod", "rem", "hypot", "pow", "sqrt", "log", "exp", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  "translate", "translatex", "translatey", "translatez", "translate3d", "scale", "scalex", "scaley", "scalez", "scale3d", "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "matrix", "matrix3d", "perspective",
  "blur", "brightness", "contrast", "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia", "drop-shadow",
  "cubic-bezier", "steps", "linear", "minmax", "repeat", "fit-content", "env", "counter", "counters", "symbols",
]);
const DENIED_PROPERTIES = new Set(["behavior", "-moz-binding", "-webkit-app-region", "app-region"]);
const HOST_TOKENS = new Set(["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary", "--primary-foreground"]);
const decode = (name) => cssTree.ident.decode(name).toLowerCase();

/** Returns canonical CSS only if every construct is safe for a clipped shadow root. */
function validatePluginCss(source, context = "stylesheet") {
  if (typeof source !== "string" || source.length > MAX_CSS_LENGTH || source.includes("\0")) throw new TypeError("Invalid plugin stylesheet");
  let ast;
  try { ast = cssTree.parse(source, { context, parseCustomProperty: true, positions: false }); }
  catch { throw new TypeError("Invalid plugin stylesheet"); }
  let count = 0;
  cssTree.walk(ast, (node) => {
    if (++count > MAX_AST_NODES) throw new TypeError("Plugin stylesheet exceeds complexity limits");
    if (node.type === "Raw" || node.type === "Url") throw new TypeError("Plugin stylesheet contains unsafe content");
    if (node.type === "Atrule" && !ALLOWED_AT_RULES.has(decode(node.name))) throw new TypeError("Plugin stylesheet contains a forbidden rule");
    if (node.type === "PseudoClassSelector" && ["host", "host-context", "global", "visited"].includes(decode(node.name))) throw new TypeError("Plugin selector crosses the view boundary");
    if (node.type === "PseudoElementSelector" && ["part", "slotted"].includes(decode(node.name))) throw new TypeError("Plugin selector crosses the view boundary");
    if (node.type === "Function") {
      const name = decode(node.name);
      if (!ALLOWED_FUNCTIONS.has(name)) throw new TypeError("Plugin stylesheet contains an unsafe function");
      if (name === "var") {
        const first = node.children?.first;
        const variable = first?.type === "Identifier" ? cssTree.ident.decode(first.name) : "";
        if (!variable.startsWith("--plugin-") && !HOST_TOKENS.has(variable)) throw new TypeError("Plugin stylesheet references an unapproved variable");
      }
    }
    if (node.type === "Declaration") {
      const property = decode(node.property);
      if (DENIED_PROPERTIES.has(property) || (property.startsWith("--") && !property.startsWith("--plugin-"))) throw new TypeError("Plugin stylesheet contains a forbidden property");
      if (property === "position") {
        const first = node.value.children?.first;
        if (!first || first.type !== "Identifier" || !["static", "relative", "absolute", "sticky"].includes(decode(first.name))
          || node.value.children.size !== 1) throw new TypeError("Plugin stylesheet contains unsafe positioning");
      }
    }
  });
  return cssTree.generate(ast);
}

function validatePluginStylesheet(source) { return validatePluginCss(source); }
function validatePluginInlineStyle(source) { return validatePluginCss(source, "declarationList"); }
module.exports = { validatePluginStylesheet, validatePluginInlineStyle, MAX_CSS_LENGTH, MAX_AST_NODES };
