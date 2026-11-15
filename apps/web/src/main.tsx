import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/archivo-narrow/latin-400.css';
import '@fontsource/archivo-narrow/latin-500.css';
import '@fontsource/archivo-narrow/latin-700.css';
import '@fontsource/nothing-you-could-do/latin-400.css';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { nativeReady } from './lib/native.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Inside the iPhone app: tell it the interface is up, which is when it asks about notifications.
nativeReady();

// The app shell is cached so the installed app opens at once, even before the Mac answers.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !new URLSearchParams(location.search).has('fixtures') && !sessionStorage.getItem('bureau.fixtures')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
