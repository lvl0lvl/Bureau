import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/archivo-narrow/latin-400.css';
import '@fontsource/archivo-narrow/latin-500.css';
import '@fontsource/archivo-narrow/latin-700.css';
import '@fontsource/nothing-you-could-do/latin-400.css';
// Typefaces for the themes. Only the declarations are loaded; a font file is fetched when used.
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter-tight/wght.css';
import '@fontsource-variable/nunito/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-700.css';
import '@fontsource/vt323/latin-400.css';
import './styles/app.css';
import './styles/themes.css';

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
