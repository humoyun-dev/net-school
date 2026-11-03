// MeshCentral viewer sahifasiga gateway qo'shadigan "ko'prik": MeshCentral'ning o'z panellari yashiriladi, ekran
// o'zi ulanadi, holat panel oynasiga postMessage bilan yuboriladi, paneldan faqat `connect`, `focus` va `cad` qabul qilinadi.
// Ruxsatlar o'zgarmaydi: har kadr baribir viewer-policy filtridan o'tadi (ko'rish rejimida kiritish tashlanadi).

export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  desktop?: { State?: number } | null;
  currentNode?: unknown;
  connectDesktop?: (event: null, contype: number) => void;
  sendCAD?: () => void;
  setInterval(fn: () => void, ms: number): unknown;
  addEventListener(type: 'message', fn: (event: { source: unknown; origin: string; data: unknown }) => void): void;
  addEventListener(type: 'mousedown', fn: () => void, capture: boolean): void;
  focus(): void;
}

// Sahifaga `toString()` bilan joylanadi: tashqi o'zgaruvchi va import ishlatilmaydi.
export function viewerBridge(win: BridgeWindow, panelOrigin: string): void {
  const CONNECTED = 3;
  // Ulanish so'ralgach ~15 s "ulanmoqda": Windows'da desktop avval sessiyalar ro'yxatini kutadi.
  const GRACE_TICKS = 50;
  let last = '';
  let started = false;
  let pending = 0;
  const stateNow = () => (win.desktop && typeof win.desktop.State === 'number' ? win.desktop.State : 0);
  const post = (state: string) => {
    if (state === last || !win.parent) return;
    last = state;
    win.parent.postMessage({ source: 'netschool-viewer', state }, panelOrigin);
  };
  const connect = () => {
    // contype 3: avval agentdan foydalanuvchi sessiyalari so'raladi (Windows), keyin desktop tunneli.
    if (stateNow() !== 0 || !win.currentNode || typeof win.connectDesktop !== 'function') return;
    pending = GRACE_TICKS;
    win.connectDesktop(null, 3);
  };
  win.setInterval(() => {
    if (!started && win.currentNode) {
      started = true;
      connect();
    }
    const s = stateNow();
    if (s !== 0) pending = 0;
    if (s === CONNECTED) post('connected');
    else if (s !== 0 || !started) post('connecting');
    else if (pending > 0) {
      pending -= 1;
      post('connecting');
    } else post('disconnected');
  }, 300);
  // MeshCentral canvas mousedown'da preventDefault qiladi va brauzer iframe'ga fokus bermaydi: klaviatura
  // (document.onkeydown) yetmaydi. Har bosishda iframe oynasi fokus oladi (capture — MeshCentral'dan oldin).
  win.addEventListener('mousedown', () => win.focus(), true);
  win.addEventListener('message', (event) => {
    const data = event.data as { target?: unknown; command?: unknown } | null;
    if (event.source !== win.parent || event.origin !== panelOrigin || !data || data.target !== 'netschool-viewer') {
      return;
    }
    if (data.command === 'connect') connect();
    else if (data.command === 'focus') win.focus();
    else if (data.command === 'cad' && stateNow() === CONNECTED && typeof win.sendCAD === 'function') win.sendCAD();
  });
}

// MeshCentral'ning o'z boshqaruv satrlari va jarayonlar paneli yashiriladi, ekran butun iframe'ni egallaydi.
const STYLE = [
  '#deskarea1, #deskarea4, #DeskTools, #p11title { display: none !important; }',
  'html, body, #container, #column_l { background: #000 !important; overflow: hidden !important; }',
  // MeshCentral balandlikni `calc(100vh - 270px)` bilan cheklaydi: ekran butun iframe'ni egallashi uchun bekor qilinadi.
  '#deskarea3x { position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important; max-height: none !important; background: #000 !important; }',
  '#DeskParent { position: absolute !important; inset: 0 !important; right: 0 !important; }',
].join('\n');

const PANEL_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export function viewerEmbedHtml(panelOrigin: string): string {
  if (!PANEL_ORIGIN.test(panelOrigin)) throw new Error('Viewer embed: invalid panel origin');
  return `<style>\n${STYLE}\n</style><script>(${viewerBridge.toString()})(window, ${JSON.stringify(panelOrigin)});</script>`;
}
