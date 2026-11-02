/// <reference lib="webworker" />
// Fon tabida asosiy oqim taymerlari sekinlashadi (Chromium: daqiqasiga 1 marta); Worker taymeri esa yo'q.
// Xabar: { start: ms } yoki { stop: true }; javob: 'tick'.
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ start?: number; stop?: boolean }>) => {
  clearInterval(timer);
  if (e.data.start) timer = setInterval(() => self.postMessage('tick'), e.data.start);
};
