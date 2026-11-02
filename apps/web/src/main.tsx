import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@bee/editor/styles.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline copies of the app and of opened docs, and browser notifications.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
