import { useCallback, useRef, useState } from 'react';
import { ApiFailure } from './client.ts';

// Bitta foydalanuvchi niyati — bitta Idempotency-Key. Tarmoq xatosi yoki 5xx'dan keyingi qayta urinish o'sha kalit
// bilan (server bir marta bajaradi); muvaffaqiyat yoki aniq 4xx javobdan keyin yangi kalit.
export function createIntent<T>(run: (key: string) => Promise<T>): { run: () => Promise<T> } {
  let key = crypto.randomUUID();
  return {
    async run() {
      try {
        const result = await run(key);
        key = crypto.randomUUID();
        return result;
      } catch (err) {
        if (err instanceof ApiFailure && err.status >= 400 && err.status < 500) key = crypto.randomUUID();
        throw err;
      }
    },
  };
}

export function useIntent<T>(run: (key: string) => Promise<T>): {
  run: () => Promise<T | undefined>;
  pending: boolean;
  error: unknown;
} {
  const runRef = useRef(run);
  runRef.current = run;
  const intent = useRef(createIntent<T>((key) => runRef.current(key)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      return await intent.current.run();
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run: go, pending, error };
}
