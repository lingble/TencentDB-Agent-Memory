/**
 * App.tsx — root component
 *
 * Responsibilities:
 *   1. Manage auth state (zustand auth store, backed by the Control panel's sessionStorage session)
 *   2. On startup, check whether the cached local session is still valid (checkSession):
 *        - checking → loading
 *        - not logged in → LoginGate
 *        - logged in → RouterProvider (ConsoleLayout + pages)
 *   3. Initialize event sync for the team store
 *   4. Provide the English locale to tea-component's ConfigProvider so its
 *      built-in strings (StatusTip loading, Table empty state, etc.) are English.
 */
import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

export default function App() {
  const { t } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);

  // On startup, check whether the cached { instance_id, user_key, user } in sessionStorage is valid
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('app.checkingSession')}</div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale="en">
      {content}
    </ConfigProvider>
  );
}
