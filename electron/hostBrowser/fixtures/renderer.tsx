// Real renderer controls with isolated desktop services, used by the Electron acceptance test.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostBrowserSidePanel } from '../../../components/HostBrowserSidePanel';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import type { TerminalSettings } from '../../../domain/models';
import '../../../index.css';

for (const [name, value] of Object.entries({ background: '210 25% 18%', foreground: '210 20% 90%', secondary: '210 20% 24%', muted: '210 20% 22%', 'muted-foreground': '210 15% 65%', border: '210 20% 30%', primary: '170 70% 42%', 'primary-foreground': '210 20% 12%', popover: '210 25% 20%' })) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.classList.add('dark');
document.documentElement.style.setProperty('--radius', '8px');
document.documentElement.style.setProperty('--ring', '170 70% 42%');
document.documentElement.style.setProperty('--input', '210 20% 30%');
document.documentElement.style.setProperty('--primary-foreground', '210 20% 12%');
document.documentElement.style.setProperty('--destructive', '0 70% 60%');

function Fixture() {
  const [visible, setVisible] = useState(true);
  const [locale, setLocale] = useState('zh-CN');
  return <I18nProvider locale={locale}><TooltipProvider delayDuration={100}>
    <div className="flex h-screen flex-col bg-background p-3 text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-3">
        {['上下分屏', '左右分屏'].map((label, index) => <Popover key={label}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><button id={`split-${index}`} className="rounded px-2 py-1 text-xs hover:bg-secondary">{label}</button></PopoverTrigger></TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip><PopoverContent align="start" className="w-48 p-1">{Array.from({ length: 8 }, (_, item) => <button key={item} className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-secondary" id={`choice-${index}-${item}`} onClick={(event) => { event.currentTarget.dataset.chosen = 'true'; }}>Panel {item + 1}</button>)}</PopoverContent></Popover>)}
        <button id="visibility" className="text-xs" onClick={() => setVisible((value) => !value)}>Toggle panel</button>
        <select aria-label="Locale" value={locale} onChange={(event) => setLocale(event.target.value)}>{['zh-CN', 'en', 'zh-TW', 'es', 'ru'].map((value) => <option key={value}>{value}</option>)}</select>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border/50">
        <HostBrowserSidePanel browserId="local:renderer-acceptance" host={{ id: 'local', protocol: 'local', label: 'Local browser', hostname: '', username: '', tags: [], os: 'macos' }} hosts={[]} keys={[]} identities={[]} knownHosts={[]} terminalSettings={{} as TerminalSettings} isVisible={visible} />
      </div>
    </div>
  </TooltipProvider></I18nProvider>;
}
createRoot(document.getElementById('fixture')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
