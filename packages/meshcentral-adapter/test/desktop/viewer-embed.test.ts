import { describe, expect, test } from 'vitest';
import { type BridgeWindow, viewerBridge, viewerEmbedHtml } from '../../src/desktop/viewer-embed.ts';

const PANEL = 'https://hub.school.lan';

// MeshCentral sahifasi global'larining soxta nusxasi: desktop.State, currentNode, connectDesktop, sendCAD.
function fakePage() {
  const posted: { msg: unknown; origin: string }[] = [];
  const calls: string[] = [];
  let tick: () => void = () => {};
  let onMessage: (e: { source: unknown; origin: string; data: unknown }) => void = () => {};
  let onMouseDown: () => void = () => {};
  let focused = 0;
  const parent = { postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }) };
  const win: BridgeWindow = {
    parent,
    desktop: null,
    currentNode: null,
    connectDesktop: (e: null, contype: number) => {
      calls.push(`connect:${e}:${contype}`);
    },
    sendCAD: () => {
      calls.push('cad');
    },
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    addEventListener: (type: string, fn: typeof onMessage) => {
      if (type === 'message') onMessage = fn;
      if (type === 'mousedown') onMouseDown = fn as unknown as () => void;
    },
    focus: () => {
      focused += 1;
    },
  };
  const states = () => posted.map((p) => (p.msg as { state: string }).state);
  return {
    win,
    parent,
    posted,
    calls,
    states,
    tick: () => tick(),
    send: (e: Parameters<typeof onMessage>[0]) => onMessage(e),
    mouseDown: () => onMouseDown(),
    focused: () => focused,
  };
}

describe('viewer bridge', () => {
  test('connects once by itself as soon as the device is loaded', () => {
    const p = fakePage();
    viewerBridge(p.win, PANEL);
    p.tick();
    expect(p.calls).toEqual([]);
    p.win.currentNode = { _id: 'node//x' };
    p.tick();
    p.tick();
    p.tick();
    expect(p.calls).toEqual(['connect:null:3']);
    expect(p.states()).toEqual(['connecting']);
    expect(p.posted.every((x) => x.origin === PANEL)).toBe(true);
    expect(p.posted[0]?.msg).toEqual({ source: 'netschool-viewer', state: 'connecting' });
  });

  test('reports connected and then disconnected', () => {
    const p = fakePage();
    viewerBridge(p.win, PANEL);
    p.win.currentNode = { _id: 'node//x' };
    p.tick();
    p.win.desktop = { State: 1 };
    p.tick();
    p.win.desktop = { State: 3 };
    p.tick();
    p.win.desktop = null;
    p.tick();
    expect(p.states()).toEqual(['connecting', 'connected', 'disconnected']);
  });

  test('obeys only the panel window: reconnect and Ctrl+Alt+Del when connected', () => {
    const p = fakePage();
    viewerBridge(p.win, PANEL);
    p.win.currentNode = { _id: 'node//x' };
    p.tick();
    p.win.desktop = null;
    const cmd = (command: string) => ({ target: 'netschool-viewer', command });
    p.send({ source: {}, origin: PANEL, data: cmd('connect') });
    p.send({ source: p.parent, origin: 'https://evil.example', data: cmd('connect') });
    p.send({ source: p.parent, origin: PANEL, data: cmd('cad') });
    expect(p.calls).toEqual(['connect:null:3']);
    p.send({ source: p.parent, origin: PANEL, data: cmd('connect') });
    expect(p.calls).toEqual(['connect:null:3', 'connect:null:3']);
    p.win.desktop = { State: 3 };
    p.send({ source: p.parent, origin: PANEL, data: cmd('connect') });
    p.send({ source: p.parent, origin: PANEL, data: cmd('cad') });
    p.send({ source: p.parent, origin: PANEL, data: { target: 'netschool-viewer', command: 'eval' } });
    expect(p.calls).toEqual(['connect:null:3', 'connect:null:3', 'cad']);
  });

  // MeshCentral canvas mousedown'da preventDefault qiladi: iframe fokus olmaydi va klaviatura yetmaydi (P0c topilmasi).
  test('a click on the remote screen focuses the viewer so the keyboard reaches it', () => {
    const p = fakePage();
    viewerBridge(p.win, PANEL);
    expect(p.focused()).toBe(0);
    p.mouseDown();
    expect(p.focused()).toBe(1);
  });

  test('the panel can hand keyboard focus to the viewer', () => {
    const p = fakePage();
    viewerBridge(p.win, PANEL);
    p.send({ source: p.parent, origin: PANEL, data: { target: 'netschool-viewer', command: 'focus' } });
    expect(p.focused()).toBe(1);
  });

  test('the embed is one style and one self-contained script bound to the panel origin', () => {
    const html = viewerEmbedHtml(PANEL);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain(`(window, ${JSON.stringify(PANEL)})`);
    for (const id of ['#deskarea1', '#deskarea4', '#DeskTools']) expect(html).toContain(id);
    expect(() => viewerEmbedHtml("https://x'</script>")).toThrow(/panel origin/);
    expect(() => viewerEmbedHtml('http://hub.school.lan')).toThrow(/panel origin/);
  });
});
