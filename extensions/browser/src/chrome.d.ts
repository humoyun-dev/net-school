// Ishlatiladigan chrome.* API'larining minimal tiplari (@types/chrome qo'shilmagan).
declare namespace chrome {
  namespace runtime {
    interface Port {
      postMessage(message: unknown): void;
      onMessage: { addListener(fn: (message: unknown) => void): void };
      onDisconnect: { addListener(fn: () => void): void };
    }
    function connectNative(application: string): Port;
    function getURL(path: string): string;
    function getManifest(): { version: string };
    const onStartup: { addListener(fn: () => void): void };
    const onInstalled: { addListener(fn: () => void): void };
  }
  namespace storage {
    interface Area {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    }
    const local: Area;
    const session: Area;
  }
  namespace declarativeNetRequest {
    function updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
    function getDynamicRules(): Promise<{ id: number }[]>;
  }
  namespace alarms {
    function create(name: string, info: { periodInMinutes: number }): void;
    const onAlarm: { addListener(fn: (alarm: { name: string }) => void): void };
  }
  namespace webNavigation {
    const onBeforeNavigate: {
      addListener(fn: (details: { tabId: number; frameId: number; url: string }) => void): void;
    };
  }
  namespace tabs {
    function update(tabId: number, props: { url: string }): Promise<unknown>;
  }
  namespace i18n {
    function getUILanguage(): string;
  }
}
