import { BLOCKED_PAGE } from './rules.ts';
import { type KV, type PolicyMessage, PolicyState } from './state.ts';
import { ExtensionSync } from './sync.ts';

// P2c managed extension (Chrome/Edge, force-install). Siyosatni native messaging host orqali Companion'dan oladi;
// mantiq ExtensionSync'da (testlangan), bu fayl faqat chrome.* API'larini ulaydi.
const HOST = 'uz.netschool.web';
const RECONNECT_MS = 5_000;

const area = (a: chrome.storage.Area): KV => ({
  get: async (key) => (await a.get(key))[key],
  set: (key, value) => a.set({ [key]: value }),
  remove: (key) => a.remove(key),
});
let port: chrome.runtime.Port | null = null;
const sync = new ExtensionSync({
  state: new PolicyState({ local: area(chrome.storage.local), session: area(chrome.storage.session) }, () =>
    Date.now(),
  ),
  dnr: {
    get: () => chrome.declarativeNetRequest.getDynamicRules(),
    update: (o) => chrome.declarativeNetRequest.updateDynamicRules(o),
  },
  post: (m) => port?.postMessage(m),
  browser: navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome',
  version: chrome.runtime.getManifest().version,
});

function connect(): void {
  const p = chrome.runtime.connectNative(HOST);
  port = p;
  p.onMessage.addListener((message) => {
    if ((message as { type?: string }).type === 'policy')
      void sync.onPolicy(message as PolicyMessage).catch(() => undefined);
  });
  p.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, RECONNECT_MS);
  });
}

const tick = () => void sync.tick().catch(() => undefined);
chrome.alarms.create('netschool-refresh', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(tick);
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0 && sync.blocked(d.url))
    void chrome.tabs.update(d.tabId, { url: chrome.runtime.getURL(BLOCKED_PAGE) });
});
tick();
connect();
