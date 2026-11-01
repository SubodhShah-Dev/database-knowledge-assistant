import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import SessionsDrawer from './SessionsDrawer';
import {
  IconClose,
  IconChevronDown,
  IconDatabase,
  IconHistory,
  IconKey,
  IconLock,
  IconLogout,
  IconMenu,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSpark,
  IconSun
} from './icons';

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function getInitials(user: { first_name?: string | null; last_name?: string | null; email?: string | null } | null | undefined): string {
  if (!user) return '?';
  if (user.first_name && user.last_name) {
    return `${user.first_name[0]}${user.last_name[0]}`.toUpperCase();
  }
  if (user.first_name) return user.first_name[0].toUpperCase();
  return user.email?.[0]?.toUpperCase() ?? '?';
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    setMenuOpen(false);
    setHistoryOpen(false);
    setAccountMenuOpen(false);
    setFocusedIndex(-1);
  }, [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 761px)');
    function onChange() {
      if (media.matches) setMenuOpen(false);
    }
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
        setFocusedIndex(-1);
      }
    }
    if (accountMenuOpen) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [accountMenuOpen]);

  useEffect(() => {
    function onResize() {
      if (window.innerWidth <= 760) {
        setAccountMenuOpen(false);
        setFocusedIndex(-1);
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!accountMenuOpen) return;
      const dropdown = dropdownRef.current;
      if (!dropdown) return;
      const items = Array.from(dropdown.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      if (items.length === 0) return;

      let next = focusedIndex;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        next = (focusedIndex + 1) % items.length;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        next = (focusedIndex - 1 + items.length) % items.length;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setAccountMenuOpen(false);
        setFocusedIndex(-1);
        return;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        items[focusedIndex]?.click();
        return;
      } else {
        return;
      }
      setFocusedIndex(next);
      items[next]?.focus();
    }
    if (accountMenuOpen) document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [accountMenuOpen, focusedIndex]);

  const isChat = location.pathname.startsWith('/c/');
  const currentSessionId = location.pathname.match(/^\/c\/([^/]+)$/)?.[1];

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  function closeAccountMenu() {
    setAccountMenuOpen(false);
    setFocusedIndex(-1);
  }

  function handleAccountTriggerClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setAccountMenuOpen(!accountMenuOpen);
    if (!accountMenuOpen) setFocusedIndex(0);
  }

  return (
    <div className={`app-shell${isChat ? ' app-shell-chat' : ''}`}>
      <header className="app-header">
        <NavLink to="/" className="brand" aria-label="Database Knowledge Assistant home">
          <span className="brand-mark">
            <IconDatabase size={20} />
          </span>
        </NavLink>

        <nav className={`main-nav${menuOpen ? ' open' : ''}`} aria-label="Main navigation">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <IconPlus size={16} /> New session
          </NavLink>
          <NavLink to="/connections" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <IconDatabase size={16} /> Connections
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink
              to="/admin/models"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <IconSpark size={16} />
              AI providers
            </NavLink>
          )}
          <div className="mobile-account">
            <span>{user?.email ?? 'Signed in'}</span>
            <NavLink
              to="/settings/models"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              onClick={() => { setMenuOpen(false); setHistoryOpen(false); }}
            >
              <IconKey size={16} /> My Models
            </NavLink>
            <NavLink
              to="/settings/api-keys"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              onClick={() => { setMenuOpen(false); setHistoryOpen(false); }}
            >
              <IconLock size={16} /> API Keys
            </NavLink>
            <NavLink
              to="/settings/profile"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              onClick={() => { setMenuOpen(false); setHistoryOpen(false); }}
            >
              <IconSettings size={16} /> Settings
            </NavLink>
            <button className="btn btn-ghost" onClick={handleLogout}>
              <IconLogout size={16} /> Sign out
            </button>
          </div>
        </nav>

        <div className="header-actions">
          <button
            className="btn btn-ghost btn-icon"
            aria-label="Session history"
            title="Session history"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen(true);
              setMenuOpen(false);
              setAccountMenuOpen(false);
            }}
          >
            <IconHistory size={18} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => {
              setTheme(theme === 'dark' ? 'light' : 'dark');
              setAccountMenuOpen(false);
            }}
          >
            {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
          <div className="account-menu" ref={accountMenuRef}>
            <button
              className="account-trigger"
              onClick={handleAccountTriggerClick}
              aria-expanded={accountMenuOpen}
              aria-haspopup="true"
              aria-controls="account-dropdown"
            >
              <span className="account-avatar" aria-hidden="true">{getInitials(user)}</span>
              <span className="account-email">{user?.email ?? 'Account'}</span>
              <IconChevronDown size={14} style={{ transition: 'transform 120ms ease', transform: accountMenuOpen ? 'rotate(180deg)' : 'rotate(0)' }} />
            </button>

            {accountMenuOpen && (
              <div
                id="account-dropdown"
                className="account-dropdown"
                ref={dropdownRef}
                role="menu"
              >
                <NavLink
                  to="/settings/models"
                  className="dropdown-item"
                  role="menuitem"
                  tabIndex={0}
                  onClick={closeAccountMenu}
                >
                  <IconKey size={16} /> My Models
                </NavLink>
                <NavLink
                  to="/settings/api-keys"
                  className="dropdown-item"
                  role="menuitem"
                  tabIndex={0}
                  onClick={closeAccountMenu}
                >
                  <IconLock size={16} /> API Keys
                </NavLink>
                <NavLink
                  to="/settings/profile"
                  className="dropdown-item"
                  role="menuitem"
                  tabIndex={0}
                  onClick={closeAccountMenu}
                >
                  <IconSettings size={16} /> Settings
                </NavLink>
                <hr className="dropdown-divider" role="separator" />
                <button
                  className="dropdown-item dropdown-danger"
                  role="menuitem"
                  tabIndex={0}
                  onClick={handleLogout}
                >
                  <IconLogout size={16} /> Sign out
                </button>
              </div>
            )}
          </div>
          <button
            className="btn btn-ghost btn-icon menu-toggle"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => {
              setHistoryOpen(false);
              setAccountMenuOpen(false);
              setMenuOpen(open => !open);
            }}
          >
            {menuOpen ? <IconClose size={19} /> : <IconMenu size={19} />}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      {historyOpen && (
        <SessionsDrawer
          currentId={currentSessionId}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}