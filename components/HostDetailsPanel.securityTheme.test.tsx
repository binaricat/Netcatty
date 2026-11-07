import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { compile } from '@tailwindcss/node';
import postcss from 'postcss';
import HostDetailsPanel from './HostDetailsPanel';
import { Card } from './ui/card';
import { TooltipProvider } from './ui/tooltip';
import { PluginPermissionPanel } from './settings/tabs/PluginPermissionPanel';
import { I18nProvider } from '../application/i18n/I18nProvider';

test('real Host form cards, inputs and Save consume scoped security aliases without freezing an ordinary card', async () => {
  const markup = renderToStaticMarkup(<I18nProvider locale="en"><TooltipProvider>
    <HostDetailsPanel availableKeys={[]} identities={[]} groups={[]} terminalThemeId="default" terminalFontSize={14} onSave={() => assert.fail('test never saves a host')} onCancel={() => {}} />
    <PluginPermissionPanel pluginId="com.example.synthetic" onChanged={async () => {}} />
    <Card id="ordinary-card">Outside the security surface</Card>
  </TooltipProvider></I18nProvider>);
  const dom = new JSDOM(`<!doctype html><html data-plugin-theme-active><body>${markup}</body></html>`);
  try {
    const panel = dom.window.document.querySelector('[data-section="host-details-panel"]')!;
    assert.ok(panel, 'exercise the actual HostDetailsPanel and AsidePanel');
    assert.ok(panel.querySelector('.bg-card'), 'General/Address/Credentials use real Card components');
    assert.ok(panel.querySelector('input.bg-background'), 'exercise actual Input utilities');
    assert.ok(panel.querySelector('button.bg-primary'), 'exercise the actual Save button');
    const permissions = dom.window.document.querySelector('[data-host-security-surface]')!;
    assert.ok(permissions.querySelector('[role="status"]'), 'exercise the real grant-panel security root without loading or changing any grants');
    const source = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    const compiler = await compile(source, {base: path.resolve('.'), onDependency() {}});
    const classes = [...new Set([...dom.window.document.querySelectorAll('[class]')].flatMap(el => [...el.classList]))];
    const css = compiler.build(classes);
    const parsed = postcss.parse(css);
    const rules: postcss.Rule[] = [];
    parsed.walkRules(rule => { rules.push(rule); });
    const rule = rules.find(node => node.selector.startsWith(':root[data-plugin-theme-active]'));
    assert.ok(rule && rule.type === 'rule');
    const matches = [...dom.window.document.querySelectorAll(rule.selector)];
    assert.ok(matches.includes(panel));
    assert.ok(matches.includes(permissions));
    assert.ok(!matches.includes(dom.window.document.getElementById('ordinary-card')!), 'security selector stays within the existing marked surfaces');
    const declarations = new Map(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node]));
    for (const name of ['background','foreground','card','card-foreground','popover','popover-foreground','primary','primary-foreground','secondary','secondary-foreground','muted','muted-foreground','accent','accent-foreground','destructive','destructive-foreground','border','input','ring']) {
      const declaration = declarations.get(`--color-${name}`);
      assert.equal(declaration?.value, `hsl(var(--host-security-${name}))`, `Tailwind alias ${name} cannot inherit the plugin value`);
      assert.equal(declaration.important, true);
    }
    for (const name of ['card','background','primary']) {
      const utility = rules.find(node => node.selector === `.bg-${name}`);
      assert.ok(utility && utility.type === 'rule');
      assert.ok(utility.nodes.some(node => node.type === 'decl' && node.prop === 'background-color' && node.value === `var(--color-${name})`), 'verify what the actual compiled utility consumes');
    }
    const mutedText = rules.find(node => node.selector === '.text-muted-foreground');
    assert.ok(mutedText?.nodes.some(node => node.type === 'decl' && node.prop === 'color' && node.value === 'var(--color-muted-foreground)'));
  } finally { dom.window.close(); }
});
