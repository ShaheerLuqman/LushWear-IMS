// Login gate / first-run org+admin setup. Rendered by App.tsx whenever
// useAuth().status === 'gate'. Same two-phase flow as the old app-core.js
// runAuthGate(): poll /auth/status, then show either a login form or a
// first-run "set up your organization" form.
import { useCallback, useEffect, useState } from 'react';
import { Button, FormLayout, InlineError, InlineStack, Spinner, Text, TextField } from '@shopify/polaris';
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
    if (!email.trim() || password.length < 8 || (!hasUsers && (!orgName.trim() || !name.trim()))) {
      setError(password.length < 8 && password ? 'Password must be at least 8 characters' : 'Fill in every field');
      return;
    }
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
        {phase === 'connecting' && (
          <InlineStack align="center" gap="200" blockAlign="center"><Spinner size="small" /><Text as="span" tone="subdued">{waitingText}</Text></InlineStack>
        )}
        {phase === 'form' && (
          <form autoComplete="off" onSubmit={handleSubmit}>
            <FormLayout>
              <Text as="h2" variant="headingLg" alignment="center">{hasUsers ? 'Log in' : 'Set up your organization'}</Text>
              {!hasUsers && <TextField label="Organization name" autoComplete="off" maxLength={200} placeholder="e.g. LushWear" requiredIndicator value={orgName} onChange={setOrgName} />}
              {!hasUsers && <TextField label="Your name" autoComplete="off" maxLength={200} placeholder="e.g. Jane Doe" requiredIndicator value={name} onChange={setName} />}
              <TextField label="Email" type="email" autoComplete="username" placeholder="you@example.com" requiredIndicator value={email} onChange={setEmail} autoFocus />
              <TextField label="Password" type="password" autoComplete={hasUsers ? 'current-password' : 'new-password'} maxLength={128} requiredIndicator value={password} onChange={setPassword} />
              {!hasUsers && <TextField label="Confirm password" type="password" autoComplete="new-password" maxLength={128} requiredIndicator value={confirmPassword} onChange={setConfirmPassword} />}
              {error && <InlineError message={error} fieldID="authGate" />}
              <Button variant="primary" submit fullWidth loading={submitting}>Continue</Button>
            </FormLayout>
          </form>
        )}
      </div>
    </div>
  );
}
