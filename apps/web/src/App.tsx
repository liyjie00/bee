import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { IconSprite } from './components/Icon';
import { Shell } from './components/Shell';
import { DocPage } from './pages/DocPage';
import { FolderPage } from './pages/FolderPage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { WelcomePage } from './pages/WelcomePage';
import { SharePage } from './pages/SharePage';
import { SettingsPage } from './pages/SettingsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SessionProvider } from './state/session';
import { ToastProvider } from './state/toast';
import { I18nProvider } from './i18n';

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <SessionProvider>
          <IconSprite />
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/welcome" element={<WelcomePage />} />
              <Route path="/s/:token" element={<SharePage />} />
              <Route path="/s/:token/d/:docId" element={<SharePage />} />
              <Route path="/p/:token" element={<SharePage />} />
              <Route element={<Shell />}>
                <Route index element={<FolderPage mode="root" />} />
                <Route path="/recent" element={<FolderPage mode="recent" />} />
                <Route path="/shared" element={<FolderPage mode="shared" />} />
                <Route path="/boards" element={<FolderPage mode="boards" />} />
                <Route path="/trash" element={<FolderPage mode="trash" />} />
                <Route path="/f/:folderId" element={<FolderPage mode="folder" />} />
                <Route path="/d/:docId" element={<DocPage />} />
                <Route path="/d/:docId/history" element={<HistoryPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </SessionProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
