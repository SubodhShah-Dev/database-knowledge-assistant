import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  IconChat,
  IconClose,
  IconDatabase,
  IconLogout,
  IconMenu,
  IconMoon,
  IconPlus,
  IconSun
} from './icons';

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const isChat = location.pathname.startsWith('/c/');

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="brand" aria-label="Database Knowledge Assistant home">
          <span className="brand-mark">
            <IconDatabase size={20} />
          </span>
          <span className="brand-text">
            <strong>Database</strong>
            <span>Knowledge Assistant</span>
          </span>
        </NavLink>

        <nav className={`main-nav${menuOpen ? ' open' : ''}`} aria-label="Main navigation">
          <NavLink to="/" end className="nav-link">
            <IconPlus size={16} /> New session
          </NavLink>
          <NavLink to="/connections" className="nav-link">
            <IconDatabase size={16} /> Connections
          </NavLink>
          {isChat && (
            <NavLink to={location.pathname} className="nav-link nav-link-active">
              <IconChat size={16} /> Session
            </NavLink>
          )}
          <div className="mobile-account">
            <span>{user?.email ?? 'Signed in'}</span>
            <button className="btn btn-ghost" onClick={handleLogout}>
              <IconLogout size={16} /> Sign out
            </button>
          </div>
        </nav>

        <div className="header-actions">
          <button
            className="btn btn-ghost btn-icon"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
          <div className="account-menu">
            <span className="account-email" title={user?.email}>
              {user?.email ?? 'Account'}
            </span>
            <button
              className="btn btn-ghost btn-icon"
              aria-label="Sign out"
              onClick={handleLogout}
            >
              <IconLogout size={17} />
            </button>
          </div>
          <button
            className="btn btn-ghost btn-icon menu-toggle"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
          >
            {menuOpen ? <IconClose size={19} /> : <IconMenu size={19} />}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
