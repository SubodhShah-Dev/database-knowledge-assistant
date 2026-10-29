import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import AppShell from './components/AppShell';
import LoginPage from './pages/LoginPage';
import NewSessionPage from './pages/NewSessionPage';
import ConnectionsPage from './pages/ConnectionsPage';
import ChatPage from './pages/ChatPage';
import SessionsPage from './pages/SessionsPage';
import AdminModelsPage from './pages/AdminModelsPage';

function RequireAuth() {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

function RequireAdmin() {
  const { user } = useAuth();
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<NewSessionPage />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="c/:id" element={<ChatPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="admin/models" element={<AdminModelsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
