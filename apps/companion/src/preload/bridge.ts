import type { AgentStatus } from '../core/agent.ts';
import type { StringKey } from '../core/i18n.ts';

// Renderer'ga beriladigan yagona yuza (spec §6): kalit, DB va hub manzili yo'q.
export interface NetschoolBridge {
  onStatus(cb: (status: AgentStatus) => void): () => void;
  onMessage(cb: (message: { id: string; text: string }) => void): () => void;
  raiseHelp(): Promise<void>;
  withdrawHelp(): Promise<void>;
  dismissMessage(id: string): void;
  strings(): Promise<Record<StringKey, string>>;
}
