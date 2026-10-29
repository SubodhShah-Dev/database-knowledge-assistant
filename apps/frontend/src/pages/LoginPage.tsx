import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  IconAlert,
  IconArrowRight,
  IconDatabase,
  IconLock,
  IconSpark,
  IconTable
} from '../components/icons';

type Mode = 'login' | 'signup';

const DEMO_ACCOUNTS = [
  { label: 'User demo', email: 'demo@example.com', password: 'DemoPassword123!' },
  { label: 'Admin demo', email: 'admin@example.com', password: 'AdminPassword123!' }
] as const;

export default function LoginPage() {
  const { token, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('DemoPassword123!');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (token) return <Navigate to="/" replace />;

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (mode === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setError('');
    if (nextMode === 'signup') {
      setEmail('');
      setPassword('');
    }
  }

  return (
    <div className="login-page">
      <section className="login-intro">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">
            <IconDatabase size={28} />
          </span>
          <span className="login-brand-name">
            <strong>Database Knowledge</strong>
            <small>ASSISTANT</small>
          </span>
        </div>

        <div className="login-hero">
          <div className="login-copy">
            <p className="eyebrow">YOUR DATA, IN CONTEXT</p>
            <h1>Make your database part of the conversation.</h1>
            <p className="lede">
              Ask real questions in plain language. Get answers grounded in your schema, with the
              query and results there to inspect.
            </p>
          </div>

          <div className="login-preview" aria-label="A preview of an answer with query evidence">
            <div className="login-preview-top">
              <span className="login-preview-dot" />
              <span>DATABASE SESSION</span>
              <span className="login-preview-live">READY</span>
            </div>
            <div className="login-preview-question">
              <span>QUESTION</span>
              <strong>How is my data connected?</strong>
            </div>
            <div className="login-preview-flow">
              <div className="login-preview-node">
                <IconTable size={15} />
                <span>Schema</span>
              </div>
              <span className="login-preview-line" />
              <div className="login-preview-node">
                <IconDatabase size={15} />
                <span>Read-only query</span>
              </div>
              <span className="login-preview-line" />
              <div className="login-preview-node login-preview-node-result">
                <IconSpark size={15} />
                <span>Evidence-backed answer</span>
              </div>
            </div>
            <div className="login-preview-foot">
              <IconLock size={14} />
              <span>Scoped to the tables in your session</span>
            </div>
          </div>
        </div>

        <ul className="login-features">
          <li>
            <IconDatabase size={17} />
            <span>PostgreSQL, MySQL, TiDB, SQL Server, SQLite &amp; MongoDB</span>
          </li>
          <li>
            <IconLock size={17} />
            <span>Encrypted credentials. Queries you can inspect.</span>
          </li>
        </ul>

        <div className="login-footnote">
          <span className="status-dot" /> A clearer view of your data starts here
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-card-brand">
            <span className="login-card-mark"><IconDatabase size={18} /></span>
            <span>WORKSPACE ACCESS</span>
          </div>
          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              type="button"
              onClick={() => changeMode('login')}
            >
              Sign in
            </button>
            <button
              role="tab"
              aria-selected={mode === 'signup'}
              className={mode === 'signup' ? 'active' : ''}
              type="button"
              onClick={() => changeMode('signup')}
            >
              Create account
            </button>
          </div>

          <div className="login-heading">
            <h2>{mode === 'login' ? 'Welcome back' : 'Start exploring'}</h2>
            <p>
              {mode === 'login'
                ? 'Sign in to pick up where you left off.'
                : 'Create an account to connect your first database.'}
            </p>
          </div>

          <form onSubmit={submit} className="form-stack">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                required
                placeholder="you@company.com"
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
                minLength={mode === 'signup' ? 8 : undefined}
                placeholder="At least 8 characters"
              />
            </label>

            {error && (
              <div className="alert alert-danger" role="alert">
                <IconAlert size={17} />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
              {!busy && <IconArrowRight size={17} />}
            </button>
          </form>

          <div className="auth-extra">
            {mode === 'login' ? (
              <div className="demo-accounts" aria-label="Demo accounts">
                <p className="demo-accounts-title">Demo accounts</p>
                {DEMO_ACCOUNTS.map(account => (
                  <div className="demo-account" key={account.email}>
                    <div className="demo-account-info">
                      <strong>{account.label}</strong>
                      <span>{account.email}</span>
                      <span>Password: {account.password}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost demo-fill"
                      aria-label={`Fill ${account.label.toLowerCase()} credentials`}
                      title={`Fill ${account.label.toLowerCase()} credentials`}
                      onClick={() => {
                        setEmail(account.email);
                        setPassword(account.password);
                        setError('');
                      }}
                    >
                      <IconArrowRight size={15} />
                      <span>Fill</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="signup-benefits" aria-label="Your workspace includes">
                <p className="demo-accounts-title">Your workspace includes</p>
                <p><IconDatabase size={16} /> Saved database connections</p>
                <p><IconSpark size={16} /> Answers with SQL and data evidence</p>
                <p><IconLock size={16} /> Encrypted credentials and private sessions</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
