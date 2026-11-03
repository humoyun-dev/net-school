// MeshCentral viewer sahifasiga gateway qo'shadigan "ko'prik": MeshCentral'ning o'z panellari yashiriladi, ekran
// o'zi ulanadi, holat panel oynasiga postMessage bilan yuboriladi, paneldan faqat `connect`, `focus`, `cad` va ro'yxatdagi `keys` qabul qilinadi.
// Ruxsatlar o'zgarmaydi: har kadr baribir viewer-policy filtridan o'tadi (ko'rish rejimida kiritish tashlanadi).

export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  desktop?: {
    State?: number;
    // MeshCentral agent-desktop: e.code'ni skan-kodga aylantirib yuboradi.
    m?: { KeyAction: { DOWN: number; UP: number }; SendKeyMsg(action: number, event: unknown): void };
  } | null;
  currentNode?: unknown;
  connectDesktop?: (event: null, contype: number) => void;
  sendCAD?: () => void;
  setInterval(fn: () => void, ms: number): unknown;
  addEventListener(type: 'message', fn: (event: { source: unknown; origin: string; data: unknown }) => void): void;
  addEventListener(type: 'mousedown', fn: () => void, capture: boolean): void;
  addEventListener(type: 'keydown' | 'keyup', fn: (event: BridgeKeyEvent) => void, capture: boolean): void;
  focus(): void;
  // MeshCentral: #deskkeys select qiymati (bayroqlar << 16 | tugma) va uni yuboradigan deskSendKeys().
  deskSendKeys?: () => void;
  document: {
    getElementById(id: 'deskkeys'): {
      value: string;
      appendChild(option: { value: string }): unknown;
      removeChild(option: { value: string }): unknown;
    } | null;
    createElement(tag: 'option'): { value: string };
  };
}

export interface BridgeKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

// Sahifaga `toString()` bilan joylanadi: tashqi o'zgaruvchi va import ishlatilmaydi.
export function viewerBridge(win: BridgeWindow, panelOrigin: string): void {
  const CONNECTED = 3;
  // Mac/brauzer o'zi ushlaydigan Windows kombinatsiyalari (MeshCentral formati: Shift 1, Alt 2, Ctrl 8, Win 16 << 16).
  const KEY_COMBOS: Record<string, number> = {
    start: 0x100000,
    taskbar: 0x100054,
    lock: 0x10004c,
    desktop: 0x100044,
    explorer: 0x100045,
    alt_tab: 0x020009,
    alt_f4: 0x020073,
    task_manager: 0x09001b,
  };
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
  // Faqat ro'yxatdagi kombinatsiya va faqat ulangan holatda; vaqtinchalik option MeshCentral ro'yxatida qolmaydi.
  const sendCombo = (combo: unknown) => {
    if (typeof combo !== 'string' || !Object.hasOwn(KEY_COMBOS, combo) || stateNow() !== CONNECTED) return;
    const select = win.document.getElementById('deskkeys');
    if (!select || typeof win.deskSendKeys !== 'function') return;
    const option = win.document.createElement('option');
    option.value = `0x${(KEY_COMBOS[combo] ?? 0).toString(16)}`;
    const previous = select.value;
    select.appendChild(option);
    select.value = option.value;
    try {
      win.deskSendKeys();
    } finally {
      select.removeChild(option);
      select.value = previous;
    }
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
  // macOS: Cmd bosib turilganda brauzer keypress chiqarmaydi, MeshCentral esa harfni faqat keypress'da yuboradi —
  // Windows faqat Win'ni olardi. Cmd+harf bu yerda (window capture, MeshCentral'dan oldin) kod bilan yuboriladi;
  // Mac Cmd bosilganda harfning keyup'ini yo'qotishi mumkin, shuning uchun bosish va qo'yish birga.
  const cmdLetter = (e: BridgeKeyEvent) =>
    e.metaKey && !e.ctrlKey && !e.altKey && typeof e.key === 'string' && e.key.length === 1;
  win.addEventListener(
    'keydown',
    (e) => {
      const m = win.desktop?.m;
      if (!cmdLetter(e) || stateNow() !== CONNECTED || !m) return;
      m.SendKeyMsg(m.KeyAction.DOWN, e);
      m.SendKeyMsg(m.KeyAction.UP, e);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  win.addEventListener(
    'keyup',
    (e) => {
      if (!cmdLetter(e) || stateNow() !== CONNECTED) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  win.addEventListener('message', (event) => {
    const data = event.data as { target?: unknown; command?: unknown } | null;
    if (event.source !== win.parent || event.origin !== panelOrigin || !data || data.target !== 'netschool-viewer') {
      return;
    }
    if (data.command === 'connect') connect();
    else if (data.command === 'focus') win.focus();
    else if (data.command === 'keys') sendCombo((data as { combo?: unknown }).combo);
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
