import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { Button } from '../ui/button.tsx';
import { AuthField, AuthLayout, authInputClass } from './auth-layout.tsx';

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
      await api.send('POST', '/api/v1/auth/password', { currentPassword, newPassword }, null, { noAuthRedirect: true });
      await props.onChanged();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure && err.status === 401 ? t('password.wrongCurrent') : errorText(err));
    }
  }

  return (
    <AuthLayout
      title={t('password.title')}
      onSubmit={submit}
      footer={
        <>
          {error && (
            <p className="text-center text-[12px] text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="w-full">
            {t('password.submit')}
          </Button>
        </>
      }
    >
      <AuthField label={t('password.current')}>
        <input
          className={authInputClass}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </AuthField>
      <AuthField label={t('password.new')}>
        <input
          className={authInputClass}
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          required
        />
      </AuthField>
    </AuthLayout>
  );
}
