import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
// The external tea-component@2.8.0 has no console-pack.css (that is the internal-only Tencent Cloud Console theme pack),
// so default-pack.css is used instead (includes the Tea Design Token system + default light theme variable definitions).
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/tea-themeable.css';
import './index.css';
import './tea-override.css';

// After WOA SSO auth, the authorization code is attached to the site URL (?code=...&state=...) on redirect back.
// The session is already established by a backend cookie and the frontend doesn't need it, so clean up the address bar after login to avoid code lingering / being copied and shared.
(function stripWoaAuthParams() {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['code', 'state']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    /* URL parse failure doesn't affect app startup */
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
