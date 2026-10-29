import React, { useEffect, useState } from 'react';
import { definePlugin, type PluginContext } from '@netcatty/plugin-sdk';
import { registerHostReactView, PluginPopover } from '@netcatty/plugin-sdk/host-react';

const css = `
.page { max-width: 760px; padding: 24px; margin: 0 auto; color: hsl(var(--foreground)); font: 14px/1.5 system-ui, sans-serif; }
.badge { color: hsl(var(--primary)); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
h1 { font-size: 26px; margin: 8px 0; } p { color: hsl(var(--muted-foreground)); }
.card { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; margin-top: 24px; padding: 20px; border: 1px solid hsl(var(--border)); border-radius: 12px; background: hsl(var(--muted)); }
textarea, select { padding: 9px; background: hsl(var(--background)); color: inherit; border: 1px solid hsl(var(--border)); border-radius: 6px; }
.check { display: flex; align-items: center; gap: 8px; } .check input { width: 16px; height: 16px; padding: 0; }
label { display: grid; gap: 8px; } input { padding: 9px; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--background)); color: inherit; }
button { border: 0; border-radius: 6px; padding: 10px 16px; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); cursor: pointer; }
button:hover { opacity: .85; } button:disabled { opacity: .45; cursor: default; }
.page[data-color="green"] { --plugin-accent: 145 65% 36%; }
.page[data-color="green"] button { background: hsl(var(--plugin-accent)); } .result { grid-column: 1 / -1; margin: 0; }
@container (max-width: 420px) { .card { grid-template-columns: 1fr; } }
`;
function Hello({ settings }: { settings: PluginContext['settings'] }) {
  const [name, setName] = useState(''); const [greeting, setGreeting] = useState('');
  const [enabled, setEnabled] = useState(true); const [color, setColor] = useState('blue'); const [note, setNote] = useState(''); const [menu, setMenu] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    const revisions = new Map<string, number>();
    const apply = async (key: string) => {
      const revision = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, revision);
      try {
        const value = await settings.get(`com.netcatty.hello-react-host.${key}`);
        if (disposed || revisions.get(key) !== revision) return;
        if (key === 'name') setName(typeof value === 'string' ? value : '');
        if (key === 'enabled') setEnabled(value !== false);
        if (key === 'color') setColor(value === 'green' ? 'green' : 'blue');
        if (key === 'note') setNote(typeof value === 'string' ? value : '');
      } catch {
        if (!disposed) setSettingsError('无法读取插件设置，请检查该插件的设置读取权限。');
      }
    };
    const subscription = settings.onDidChange(({ settingId }) => {
      const key = settingId.slice('com.netcatty.hello-react-host.'.length);
      if (['name', 'enabled', 'color', 'note'].includes(key)) void apply(key);
    });
    void Promise.all(['name', 'enabled', 'color', 'note'].map(apply)).then(() => {
      if (!disposed) setSettingsReady(true);
    });
    return () => { disposed = true; subscription.dispose(); };
  }, [settings]);
  if (!settingsReady) return <main className="page"><p role="status">正在读取插件设置…</p></main>;
  return <main className="page" data-color={color}><img src="asset:mark.svg" alt="Example mark" width="32" height="32" /><span className="badge">NETCATTY · HELLO</span><h1>你好，世界！</h1><p>一个融入 Netcatty 的小工作台。试试问候、便签和菜单。</p>
    {settingsError && <p role="alert">{settingsError}</p>}
    <div className="card"><label>你的称呼<input type="text" value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="输入称呼" /></label>
      <button type="button" disabled={!enabled} onClick={() => setGreeting(`你好，${name || '朋友'}！`)}>打个招呼</button><p className="result">{greeting}</p></div>
    <div className="card"><label className="check"><input aria-label="Enable greeting" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />启用问候</label>
      <label>颜色<select aria-label="Color" value={color} onChange={(event) => setColor(event.currentTarget.value)}><option value="blue">蓝色</option><option value="green">绿色</option></select></label>
      <label>便签<textarea aria-label="Note" value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="试试中文输入" /></label>
      <button type="button" onClick={() => { setName('朋友'); setEnabled(true); setColor('green'); setNote('你好，Netcatty'); }}>填入示例</button>
      <p className="result" data-testid="controls">{enabled ? '已启用' : '已停用'} · {color} · {note}</p>
      <button id="menu-trigger" type="button" onClick={() => setMenu((value) => !value)}>自定义菜单</button><PluginPopover anchor="menu-trigger" open={menu} onClose={() => setMenu(false)}><section style={{ padding: 16 }}><h2>插件自定义内容</h2><p>选择一个操作，或按 Esc 返回。</p><button type="button" onClick={() => { setGreeting('你好，来自菜单的问候！'); setMenu(false); }}>从菜单打招呼</button></section></PluginPopover>
    </div></main>;
}
export default definePlugin({ activate(context) {
  for (const id of ['vault', 'sidebar', 'tab', 'aside', 'panel', 'modal']) {
    context.subscriptions.add(registerHostReactView(context.views, `com.netcatty.hello-react-host.${id}`, () => <Hello settings={context.settings} />, css));
  }
} });
