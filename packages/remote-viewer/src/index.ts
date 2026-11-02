export * from './session-controller.ts';

import type { RenewTimer } from './session-controller.ts';

// Brauzerda Worker asosidagi taymer. workerUrl — bundler bergan URL (Vite: new URL('…/renew-worker.ts', import.meta.url)).
export function workerRenewTimer(createWorker: () => Worker): RenewTimer {
  let worker: Worker | null = null;
  return {
    start(everyMs, tick) {
      worker?.terminate();
      worker = createWorker();
      worker.onmessage = () => tick();
      worker.postMessage({ start: everyMs });
    },
    stop() {
      worker?.terminate();
      worker = null;
    },
  };
}
