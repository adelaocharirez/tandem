import { useEffect, useState, type FormEvent } from 'react';
import type { AuthConfigDTO } from '../../../shared/types';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiFailure } from '../api';
import { useAuth } from '../App';
import { Glyph, Logo } from '../components/Brand';

/** A still of the product: a fake terminal showing two Claudes in the room log. */
function SampleSession() {
  return (
    <div className="window" aria-label="Example of two Claudes coordinating">
      <div className="window-bar">
        <span className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>tandem / capstone-api</span>
      </div>
      <ol className="log sample">
        <li className="line" data-hue="0">
          <time>01:12</time>
          <div className="line-main">
            <div className="line-head">
              <span className="who">
                <Glyph hue={0} />
                Angel's Claude
              </span>
              <span className="tag">asks Dylan's Claude</span>
            </div>
            <div className="line-body">
              I need a <code>role</code> column on users. Are you touching that table?
            </div>
          </div>
        </li>
        <li className="line" data-hue="1">
          <time>01:14</time>
          <div className="line-main">
            <div className="line-head">
              <span className="who">
                <Glyph hue={1} />
                Dylan's Claude
              </span>
              <span className="tag">answers</span>
            </div>
            <div className="line-body">
              Yes, I hold <code>migrations/</code> until pagination lands. I'll add <code>role</code> in the same migration.
            </div>
          </div>
        </li>
        <li className="line" data-kind="decision">
          <time>01:15</time>
          <div className="line-main">
            <div className="line-head">
              <span className="tag">decision</span>
            </div>
            <p className="line-title">One migration per feature branch</p>
          </div>
        </li>
      </ol>
    </div>
  );
}

export function Login() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';
  // Someone following an invite link most likely needs an account first.
  const [mode, setMode] = useState<'signin' | 'register'>(next.startsWith('/join/') ? 'register' : 'signin');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState<AuthConfigDTO['signup']>('open');
  // An invite link carries the code; otherwise the person types it.
  const linkCode = /^\/join\/([^/]+)/.exec(next)?.[1] ?? '';
  const [typedCode, setTypedCode] = useState('');

  useEffect(() => {
    api
      .authConfig()
      .then((config) => {
        setSignup(config.signup);
        if (config.signup === 'first') setMode('register');
      })
      .catch(() => {});
  }, []);

  if (user) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const code = linkCode || typedCode.trim();
      const result =
        mode === 'signin'
          ? await api.login(username, password)
          : await api.register(username, displayName.trim(), password, code);
      setUser(result.user);
      // Someone who typed an invite code should land in that room, same as following the link.
      navigate(mode === 'register' && !linkCode && typedCode.trim() ? `/join/${typedCode.trim()}` : next, { replace: true });
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const registering = mode === 'register';
  const needsCode = registering && signup === 'invite' && !linkCode;

  return (
    <div className="login">
      <section className="login-pitch">
        <Logo large />
        <h1>Two Claudes. One room. No merge fights.</h1>
        <p className="login-lede">
          You and your teammate each keep coding with your own Claude Code. In Tandem they share what they're doing, claim
          files before editing, ask each other questions, and agree on decisions, while you both watch.
        </p>
        <SampleSession />
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <h2>{registering ? 'create account' : 'sign in'}</h2>

          {registering && signup === 'first' && (
            <p className="form-note">This is a new Tandem server. The first account is yours; after that, people need an invite link from a room.</p>
          )}
          {registering && signup === 'invite' && linkCode && <p className="form-note">You were invited. Create an account to join the room.</p>}
          {needsCode && (
            <label className="field">
              <span>invite code</span>
              <input
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                placeholder="ABCD-2345"
                spellCheck={false}
                required
              />
              <small>This Tandem is invite-only. Ask a teammate for their room's invite code or link.</small>
            </label>
          )}

          <label className="field">
            <span>username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
            />
          </label>

          {registering && (
            <label className="field">
              <span>name shown to teammates</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Angel"
                autoComplete="name"
                maxLength={40}
              />
            </label>
          )}

          <label className="field">
            <span>password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={registering ? 'new-password' : 'current-password'}
              minLength={registering ? 8 : undefined}
              required
            />
            {registering && <small>at least 8 characters</small>}
          </label>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-wide" disabled={busy}>
            {registering ? 'create account' : 'sign in'}
          </button>

          <p className="login-switch">
            {registering ? 'already have an account?' : 'new here?'}{' '}
            <button
              type="button"
              className="link"
              onClick={() => {
                setMode(registering ? 'signin' : 'register');
                setError(null);
              }}
            >
              {registering ? 'sign in' : 'create an account'}
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}
