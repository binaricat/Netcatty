import { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/mona-sans/400.css';
import '@fontsource/mona-sans/500.css';
import '@fontsource/mona-sans/600.css';
import '@fontsource/mona-sans/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import App from './App';
import { ToastProvider } from './components/ui/toast';
import { TooltipProvider } from './components/ui/tooltip';

const LazySettingsPage = lazy(() => import('./components/SettingsPage'));
const LazyTrayPanel = lazy(() => import('./components/TrayPanel'));
const LazyTerminalPopupPage = lazy(() => import('./components/TerminalPopupPage'));

function SettingsWindowFallback() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
        fontFamily: 'Mona Sans, PingFang SC, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          borderBottom: '1px solid hsl(var(--border))',
          padding: '20px 16px 12px',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Settings</div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>
          Loading preferences...
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 224,
            flexShrink: 0,
            borderRight: '1px solid hsl(var(--border))',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              style={{
                height: 36,
                borderRadius: 8,
                background: index === 0 ? 'hsl(var(--card))' : 'hsl(var(--muted) / 0.45)',
              }}
            />
          ))}
        </div>

        <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              style={{
                height: index === 0 ? 54 : 76,
                borderRadius: 12,
                background: 'hsl(var(--muted) / 0.38)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TerminalPopupWindowFallback() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b1015',
        color: '#d7e0ea',
      }}
    >
      <svg width="28" height="28" viewBox="0 0 28 28" aria-label="Loading" style={{ opacity: 0.8 }}>
        <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.18" />
        <path d="M25 14a11 11 0 0 0-11-11" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2">
          <animateTransform
            attributeName="transform"
            dur="0.75s"
            from="0 14 14"
            repeatCount="indefinite"
            to="360 14 14"
            type="rotate"
          />
        </path>
      </svg>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Simple hash-based routing for separate windows
const getRoute = () => {
  const hash = window.location.hash;
  if (hash === '#/settings' || hash.startsWith('#/settings')) {
    return 'settings';
  }
  if (hash === '#/tray' || hash.startsWith('#/tray')) {
    return 'tray';
  }
  if (hash === '#/terminal-popup' || hash.startsWith('#/terminal-popup')) {
    return 'terminal-popup';
  }
  if (hash === '#/session-window' || hash.startsWith('#/session-window')) {
    return 'main';
  }
  return 'main';
};

const root = ReactDOM.createRoot(rootElement);

const renderApp = () => {
  const route = getRoute();
  if (route === 'settings') {
    root.render(
      <ToastProvider>
        <TooltipProvider delayDuration={300}>
          <Suspense fallback={<SettingsWindowFallback />}>
            <LazySettingsPage />
          </Suspense>
        </TooltipProvider>
      </ToastProvider>
    );
  } else if (route === 'tray') {
    root.render(
      <ToastProvider>
        <TooltipProvider delayDuration={300}>
          <Suspense fallback={<div style={{ padding: 12, color: '#fff' }}>Loading tray panel…</div>}>
            <LazyTrayPanel />
          </Suspense>
        </TooltipProvider>
      </ToastProvider>
    );
  } else if (route === 'terminal-popup') {
    root.render(
      <ToastProvider>
        <TooltipProvider delayDuration={300}>
          <Suspense fallback={<TerminalPopupWindowFallback />}>
            <LazyTerminalPopupPage />
          </Suspense>
        </TooltipProvider>
      </ToastProvider>
    );
  } else {
    root.render(<App />);
  }
};

// Initial render
renderApp();

// Listen for hash changes
window.addEventListener('hashchange', renderApp);
