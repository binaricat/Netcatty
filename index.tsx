import { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
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

function SettingsWindowFallback() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
        fontFamily: 'Space Grotesk, system-ui, sans-serif',
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
  } else {
    root.render(<App />);
  }
};

// Initial render
renderApp();

// Listen for hash changes
window.addEventListener('hashchange', renderApp);
