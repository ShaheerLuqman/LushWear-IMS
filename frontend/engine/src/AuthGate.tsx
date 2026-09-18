// Login gate / first-run org+admin setup. Rendered by App.tsx whenever
// useAuth().status === 'gate'. Same two-phase flow as the old app-core.js
// runAuthGate(): poll /auth/status, then show either a login form or a
// first-run "set up your organization" form.
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiErrorMessage } from './api';
import { useAuth } from './auth/AuthContext';

type Phase = 'connecting' | 'form';

export function AuthGate() {
  const { completeLogin } = useAuth();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [waitingText, setWaitingText] = useState('Connecting to server…');
  const [hasUsers, setHasUsers] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const loadStatus = useCallback(async () => {
    for (;;) {
      try {
        const r = await fetch(`${API_BASE}/auth/status`);
        const data = await r.json().catch(() => ({}));

        if (r.status === 503) {
          setPhase('form');
          setError(apiErrorMessage(data, 'Request failed'));
          return;
        }
        if (!r.ok) {
          throw new Error(apiErrorMessage(data, 'Request failed'));
        }

        setHasUsers(!!data.has_users);
        setPhase('form');
        setTimeout(() => emailRef.current?.focus(), 0);
        return;
      } catch {
        setWaitingText('Waiting for server…');
        await new Promise((t) => setTimeout(t, 800));
      }
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!hasUsers && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      if (!hasUsers) {
        const r = await fetch(`${API_BASE}/auth/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_name: orgName, name, email, password }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(apiErrorMessage(data, 'Request failed'));
        }
        await completeLogin(data.token);
        return;
      }

      const r = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(r.status === 401 ? 'Incorrect email or password' : apiErrorMessage(data, 'Request failed'));
        setPassword('');
        setTimeout(() => passwordRef.current?.focus(), 0);
        return;
      }
      await completeLogin(data.token, data.user);
    } catch (ex: any) {
      setError(ex?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-gate-root">
      <div className="auth-gate-card">
        <img src="/assets/Logo_Large.png" alt="" className="auth-gate-logo" />
        {phase === 'form' && (
          <h2 className="auth-gate-title">{hasUsers ? 'Log in' : 'Set up your organization'}</h2>
        )}
        {phase === 'connecting' && (
          <p className="auth-gate-waiting">
            <span className="auth-gate-spinner"></span>
            {waitingText}
          </p>
        )}
        {phase === 'form' && (
          <form className="auth-gate-form" autoComplete="off" onSubmit={handleSubmit}>
            {!hasUsers && (
              <div className="auth-gate-extra-field">
                <label className="auth-gate-label" htmlFor="authGateOrgName">Organization name</label>
                <input
                  type="text" id="authGateOrgName" className="auth-gate-input" maxLength={200}
                  placeholder="e.g. LushWear" required value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </div>
            )}
            {!hasUsers && (
              <div className="auth-gate-extra-field">
                <label className="auth-gate-label" htmlFor="authGateName">Your name</label>
                <input
                  type="text" id="authGateName" className="auth-gate-input" maxLength={200}
                  placeholder="e.g. Jane Doe" required value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
            <label className="auth-gate-label" htmlFor="authGateEmail">Email</label>
            <input
              ref={emailRef} type="email" id="authGateEmail" className="auth-gate-input"
              required autoComplete="username" placeholder="you@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="auth-gate-label" htmlFor="authGatePassword">Password</label>
            <input
              ref={passwordRef} type="password" id="authGatePassword" className="auth-gate-input"
              minLength={8} maxLength={128} required
              autoComplete={hasUsers ? 'current-password' : 'new-password'}
              placeholder="••••••••" value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!hasUsers && (
              <div className="auth-gate-extra-field">
                <label className="auth-gate-label" htmlFor="authGateConfirmPassword">Confirm password</label>
                <input
                  type="password" id="authGateConfirmPassword" className="auth-gate-input"
                  minLength={8} maxLength={128} required autoComplete="new-password"
                  placeholder="••••••••" value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            )}
            <p className="auth-gate-error" role="alert">{error}</p>
            <button type="submit" className="btn btn-primary auth-gate-submit" disabled={submitting}>
              {submitting
                ? <><span className="btn-spinner"></span>{hasUsers ? 'Logging in…' : 'Setting up…'}</>
                : 'Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
