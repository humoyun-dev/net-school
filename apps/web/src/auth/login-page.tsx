import { loginResponseSchema } from '@netschool/contracts';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { safeNext } from './safe-next.ts';

export function LoginPage(props: { onSignedIn: () => void | Promise<void> }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await api.send('POST', '/api/v1/auth/login', { username, password }, loginResponseSchema);
      await props.onSignedIn();
      navigate(res.user.mustChangePassword ? '/password' : safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure && err.status === 401 ? t('login.failed') : errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth">
      <form className="card auth-form" onSubmit={submit}>
        <h1>{t('login.title')}</h1>
        <label>
          {t('login.username')}
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {t('login.submit')}
        </button>
      </form>
    </main>
  );
}
