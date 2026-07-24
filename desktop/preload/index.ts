// preload：用 contextBridge 暴露最小安全 API 给渲染进程（隔离，不开 nodeIntegration）。
import { contextBridge, ipcRenderer } from "electron";

const EVENTS = [
  "evt:ready",
  "evt:assistant-delta",
  "evt:tool-start",
  "evt:tool-end",
  "evt:permission-request",
  "evt:usage",
  "evt:ratelimits",
  "evt:compact",
  "evt:done",
  "evt:stopped",
  "evt:error",
  "evt:sessions",
  "evt:session-loaded",
  "evt:account",
  "evt:tasks",
  "evt:mcp",
  "evt:browser",
  "evt:browser-activity",
  "evt:browser-detached",
  "evt:suggest",
  "evt:groups",
] as const;

contextBridge.exposeInMainWorld("minicc", {
  send: (sid: string, text: string, images?: string[]) =>
    ipcRenderer.send("chat:send", sid, text, images),
  stop: (sid?: string) => ipcRenderer.send("chat:stop", sid),
  reset: () => ipcRenderer.send("chat:reset"),
  undoLast: () => ipcRenderer.send("chat:undo-last"),
  newSession: () => ipcRenderer.send("session:new"),
  switchSession: (id: string) => ipcRenderer.send("session:switch", id),
  deleteSession: (id: string) => ipcRenderer.send("session:delete", id),
  setSessionGroup: (id: string, group?: string | null) =>
    ipcRenderer.send("session:set-group", id, group),
  setSessionPriority: (id: string, priority: number) =>
    ipcRenderer.send("session:set-priority", id, priority),
  setSessionOrder: (id: string, order: number) =>
    ipcRenderer.send("session:set-order", id, order),
  reorderGroups: (names: string[]) => ipcRenderer.send("session:reorder-groups", names),
  setGroupMode: (mode: "manual" | "date" | "project") =>
    ipcRenderer.send("settings:set-group-mode", mode),
  deleteExchange: (sid: string, ordinal: number) =>
    ipcRenderer.send("session:delete-exchange", sid, ordinal),
  bootstrap: () => ipcRenderer.invoke("session:bootstrap") as Promise<any>,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.send("settings:set", s),
  getMemory: () => ipcRenderer.invoke("memory:get") as Promise<string>,
  setMemory: (text: string) => ipcRenderer.send("memory:set", text),
  getMcp: () =>
    ipcRenderer.invoke("mcp:get") as Promise<{
      config: string;
      status: { name: string; status: string; error: string; tools: number }[];
    }>,
  setMcp: (text: string) => ipcRenderer.send("mcp:set", text),
  searchMcp: (query: string, cursor?: string) =>
    ipcRenderer.invoke("mcp:search", query, cursor) as Promise<{
      results: {
        name: string;
        fullName: string;
        description: string;
        command: string;
        args: string[];
        repo: string;
        version: string;
      }[];
      nextCursor: string;
    }>,
  browserShow: (b: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("browser:show", b),
  browserHide: () => ipcRenderer.send("browser:hide"),
  browserNav: (action: string, arg?: string) => ipcRenderer.send("browser:nav", action, arg),
  browserDetach: () => ipcRenderer.send("browser:detach"),
  browserReattach: () => ipcRenderer.send("browser:reattach"),
  getAccount: () => ipcRenderer.invoke("account:get"),
  logout: () => ipcRenderer.send("account:logout"),
  webLogin: (pid: string) => ipcRenderer.invoke("account:web-login", pid),
  // 应用内弹窗授权(自行输账号密码)
  claudeLogin: () => ipcRenderer.invoke("account:claude-login") as Promise<string | null>,
  // 系统浏览器授权：第1步开浏览器，第2步用授权码换 token
  claudeOauthOpen: () => ipcRenderer.invoke("account:claude-oauth-open") as Promise<boolean>,
  claudeOauthExchange: (code: string) =>
    ipcRenderer.invoke("account:claude-oauth-exchange", code) as Promise<string | null>,
  readClipboard: () => ipcRenderer.invoke("util:read-clipboard") as Promise<string>,
  platform: process.platform,
  winMinimize: () => ipcRenderer.send("win:minimize"),
  winMaximize: () => ipcRenderer.send("win:maximize"),
  winClose: () => ipcRenderer.send("win:close"),
  checkConn: () =>
    ipcRenderer.invoke("conn:check") as Promise<{ status: "green" | "yellow" | "red"; reason: string }>,
  testKey: (key: string, override?: { provider?: string; baseUrl?: string; model?: string }) =>
    ipcRenderer.invoke("conn:test-key", key, override) as Promise<{ ok: boolean; reason: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  respondPermission: (id: number, decision: "allow" | "deny") =>
    ipcRenderer.send("perm:respond", id, decision),
  // 统一事件订阅：cb(channel, payload)
  onEvent: (cb: (channel: string, payload: unknown) => void) => {
    const handlers: Array<[string, (...a: unknown[]) => void]> = [];
    for (const ch of EVENTS) {
      const h = (_e: unknown, payload: unknown) => cb(ch, payload);
      ipcRenderer.on(ch, h);
      handlers.push([ch, h]);
    }
    // 返回清理函数：卸载全部监听，避免重复注册(HMR/重挂载时监听叠加→事件被重复处理)
    return () => {
      for (const [ch, h] of handlers) ipcRenderer.removeListener(ch, h);
    };
  },
});
