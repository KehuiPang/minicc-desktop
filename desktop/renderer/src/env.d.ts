// 渲染进程可见的 window.minicc 类型（来自 preload）
export interface MiniccApi {
  send(sid: string, text: string, images?: string[]): void;
  inject(sid: string, text: string, images?: string[]): void;
  stop(sid?: string): void;
  reset(): void;
  undoLast(): void;
  newSession(): void;
  switchSession(id: string): void;
  deleteSession(id: string): void;
  setSessionGroup(id: string, group?: string | null): void;
  setSessionPriority(id: string, priority: number, tag?: string): void;
  setSessionOrder(id: string, order: number): void;
  reorderGroups(names: string[]): void;
  setGroupMode(mode: "manual" | "date" | "project"): void;
  deleteExchange(sid: string, ordinal: number): void;
  bootstrap(): Promise<{ sessions: any[]; groups?: string[]; currentId: string; messages: any[]; usage?: any; rateLimits?: any }>;
  getSettings(): Promise<{ settings: any; backend: string; model: string; defaultPrompt?: string }>;
  setSettings(s: any): void;
  getMemory(): Promise<string>;
  setMemory(text: string): void;
  getMcp(): Promise<{ config: string; status: { name: string; status: string; error: string; tools: number }[] }>;
  setMcp(text: string): void;
  searchMcp(
    query: string,
    cursor?: string,
  ): Promise<{
    results: { name: string; fullName: string; description: string; command: string; args: string[]; repo: string; version: string }[];
    nextCursor: string;
  }>;
  browserShow(b: { x: number; y: number; width: number; height: number }): void;
  browserHide(): void;
  browserNav(action: string, arg?: string): void;
  browserDetach(): void;
  browserReattach(): void;
  getAccount(): Promise<{ loggedIn: boolean; email: string | null }>;
  logout(): void;
  webLogin(pid: string): Promise<boolean>;
  claudeLogin(): Promise<string | null>;
  claudeOauthOpen(): Promise<boolean>;
  claudeOauthExchange(code: string): Promise<string | null>;
  readClipboard(): Promise<string>;
  platform: string;
  winMinimize(): void;
  winMaximize(): void;
  winClose(): void;
  checkConn(): Promise<{ status: "green" | "yellow" | "red"; reason: string }>;
  testKey(
    key: string,
    override?: { provider?: string; baseUrl?: string; model?: string },
  ): Promise<{ ok: boolean; reason: string }>;
  openExternal(url: string): void;
  respondPermission(id: number, decision: "allow" | "deny"): void;
  onEvent(cb: (channel: string, payload: unknown) => void): () => void;
}
declare global {
  interface Window {
    minicc: MiniccApi;
  }
}
export {};
