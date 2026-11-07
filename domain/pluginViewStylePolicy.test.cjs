"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePluginStylesheet } = require("./pluginViewStylePolicy.cjs");

test("plugin styling supports ordinary layouts, animation and scoped theme tokens", () => {
  const css = `.layout { display: grid; grid-template-columns: 1fr 2fr; gap: 12px; --plugin-accent: #fa0; color: hsl(var(--foreground)); }
  @media (max-width: 400px) { .layout { display:flex; flex-direction:column; } }
  @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
  .action:hover { animation:spin 1s; color:var(--plugin-accent); }`;
  assert.doesNotThrow(() => validatePluginStylesheet(css));
});

test("plugin CSS rejects network loads, escapes and access outside the surface", () => {
  const attacks = [
    '@import "https://bad.example/a.css";', '@\\69mport "https://bad.example/a.css";',
    '.x{background:url(https://bad.example/x)}', '.x{--plugin-a:url(https://bad.example)}',
    '.x{background:u\\72l(https://bad.example)}', '.x{background:i\\6d age-set("https://bad.example" 1x)}',
    '@font-face{font-family:x;src:url(https://bad.example/font)}', ':host{position:absolute}',
    ':host-context(.secret) .x {color:red}', '.x::part(secret){color:red}',
    '.x{position:fixed}', '.x{position:fi\\78 ed}', '.x{--plugin-pos:fixed;position:var(--plugin-pos)}', '.x{background:image("https://bad.example/x")}', '.x{-webkit-app-region:drag}', '.x{background:var(--host-secret)}',
    '.x{--foreground:red}', '.x{content:attr(data-secret)}', '.x{color:red;}\0',
  ];
  for (const attack of attacks) assert.throws(() => validatePluginStylesheet(attack), undefined, attack);
  assert.throws(() => validatePluginStylesheet('x'.repeat(65537)));
});
