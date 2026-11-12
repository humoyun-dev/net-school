import { BLOCKED_PAGE, isBlocked, MAX_PATTERNS_PER_REGEX, toDnrRules } from './rules.ts';
import { type Effective, type KV, type PolicyMessage, PolicyState } from './state.ts';

// P2c managed extension (Chrome/Edge, force-install). Siyosatni native messaging host orqali Companion'dan oladi,
// declarativeNetRequest dinamik qoidalariga aylantiradi, qo'llanganini tekshirib natijani qaytaradi.
const HOST = 'uz.netschool.web';
const RECONNECT_MS = 5_000;

const area = (a: chrome.storage.Area): KV => ({
  get: async (key) => (await a.get(key))[key],
  set: (key, value) => a.set({ [key]: value }),
  remove: (key) => a.remove(key),
});
const state = new PolicyState({ local: area(chrome.storage.local), session: area(chrome.storage.session) }, () =>
  Date.now(),
);
const browser: 'chrome' | 'edge' = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
let port: chrome.runtime.Port | null = null;
let current: Effective | null = null;

async function install(groupSize: number): Promise<number> {
  const rules = toDnrRules(current?.web ?? { block: [], allowOnly: null }, groupSize);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
  return rules.length;
}

async function apply(eff: Effective): Promise<void> {
  // Navigatsiya tekshiruvi DNR'dan oldin yangilanadi: DNR yiqilsa ham asosiy sahifalar bloklanadi (fail-closed).
  current = eff;
  let expected: number;
  try {
    expected = await install(MAX_PATTERNS_PER_REGEX);
  } catch {
    // Regex guruhi RE2 chegarasidan oshgan bo'lishi mumkin: har pattern alohida qoida bilan qayta urinish.
    expected = await install(1);
  }
  // Haqiqatda o'rnatilganini tekshirish: receipt faqat tasdiqlangan holat uchun; xato bo'lsa receipt yuborilmaydi.
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  if (installed.length !== expected) throw new Error('dnr rules mismatch');
  port?.postMessage({
    type: 'applied',
    browser,
    extensionVersion: chrome.runtime.getManifest().version,
    baselineHash: eff.baselineHash,
    lessonHash: eff.lessonHash,
  });
}

function connect(): void {
  const p = chrome.runtime.connectNative(HOST);
  port = p;
  p.onMessage.addListener((message) => {
    const msg = message as { type?: string };
    if (msg.type === 'policy')
      void state
        .onPolicy(message as PolicyMessage)
        .then(apply)
        .catch(() => undefined);
  });
  p.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, RECONNECT_MS);
  });
}

// Dars muddati tugaganini tekshirish (Companion yo'q bo'lsa ham dars qoidalari ≤ 120 s'da tushadi).
async function refresh(): Promise<void> {
  const eff = await state.effective();
  if (!current || current.lessonHash !== eff.lessonHash || current.baselineHash !== eff.baselineHash) await apply(eff);
}

chrome.alarms.create('netschool-refresh', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void refresh().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void refresh().catch(() => undefined));
chrome.runtime.onInstalled.addListener(() => void refresh().catch(() => undefined));
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0 || !current) return;
  if (isBlocked(current.web, d.url)) void chrome.tabs.update(d.tabId, { url: chrome.runtime.getURL(BLOCKED_PAGE) });
});
void refresh().catch(() => undefined);
connect();
