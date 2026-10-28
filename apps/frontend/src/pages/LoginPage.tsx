import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { IconAlert, IconArrowRight, IconDatabase, IconLock, IconSpark } from '../components/icons';

type Mode = 'login' | 'signup';

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

  return (
    <div className="login-page">
      <section className="login-intro">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">
            <IconDatabase size={28} />
          </span>
          <span>Database Knowledge Assistant</span>
        </div>

        <div className="login-copy">
          <p className="eyebrow">Read-only SQL · Visible evidence</p>
          <h1>Ask your database a question. See exactly how it answered.</h1>
          <p className="lede">
            Connect PostgreSQL, choose the tables in scope, and inspect the generated SQL,
            rows, and relationships behind every response.
          </p>
        </div>

        <ul className="login-features">
          <li>
            <IconLock size={18} />
            <span>Credentials encrypted; queries run in read-only transactions.</span>
          </li>
          <li>
            <IconSpark size={18} />
            <span>Schema and data questions answered from a controlled table scope.</span>
          </li>
          <li>
            <IconArrowRight size={18} />
            <span>Streaming answers with query evidence you can copy and verify.</span>
          </li>
        </ul>

        <div className="login-footnote">
          <span className="status-dot" /> Local demo: PostgreSQL on 5434 / 5435
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Sign in
            </button>
            <button
              role="tab"
              aria-selected={mode === 'signup'}
              className={mode === 'signup' ? 'active' : ''}
              onClick={() => {
                setMode('signup');
                setError('');
              }}
            >
              Create account
            </button>
          </div>

          <div className="login-heading">
            <h2>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h2>
            <p>
              {mode === 'login'
                ? 'Sign in to continue to your sessions and saved connections.'
                : 'Use an email and a password of at least 8 characters.'}
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

          {mode === 'login' && (
            <div className="demo-hint">
              <div>
                <strong>Demo account</strong>
                <span>demo@example.com · DemoPassword123!</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setEmail('demo@example.com');
                  setPassword('DemoPassword123!');
                }}
              >
                Use demo
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
