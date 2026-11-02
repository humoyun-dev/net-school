import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../api/api-context.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';

export function PasswordPage(props: { onChanged: () => void | Promise<void> }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 12) {
      setError(t('password.tooShort'));
      return;
    }
    try {
      await api.send('POST', '/api/v1/auth/password', { currentPassword, newPassword }, null);
      await props.onChanged();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <main className="auth">
      <form className="card auth-form" onSubmit={submit}>
        <h1>{t('password.title')}</h1>
        <label>
          {t('password.current')}
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label>
          {t('password.new')}
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit">{t('password.submit')}</button>
      </form>
    </main>
  );
}
