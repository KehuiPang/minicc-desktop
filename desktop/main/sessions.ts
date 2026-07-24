// 会话持久化：会话列表 + 每会话消息存到 ~/.minicc/。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/types.js";

const DIR = join(homedir(), ".minicc");
const SDIR = join(DIR, "sessions");
const META = join(DIR, "sessions.json");
const GROUPS = join(DIR, "groups.json"); // 分组顺序(手动),新组前插=置顶

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  usage?: { totalInput: number; totalOutput: number; lastInput: number };
  group?: string; // 所属分组名；空=未分组
  priority?: number; // 优先级：数字越大越靠前(默认 0)
}

function ensure() {
  mkdirSync(SDIR, { recursive: true });
}

export function listSessions(): SessionMeta[] {
  ensure();
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return [];
  }
}

function saveList(l: SessionMeta[]) {
  ensure();
  writeFileSync(META, JSON.stringify(l));
}

// —— 分组顺序(手动) ——
export function listGroups(): string[] {
  ensure();
  try {
    const g = JSON.parse(readFileSync(GROUPS, "utf8"));
    return Array.isArray(g) ? g.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveGroups(g: string[]) {
  ensure();
  writeFileSync(GROUPS, JSON.stringify(g));
}
// 清掉没有任何会话在用的空组(保持组列表干净)
function pruneGroups() {
  const used = new Set(listSessions().map((s) => s.group).filter(Boolean) as string[]);
  const kept = listGroups().filter((g) => used.has(g));
  saveGroups(kept);
}

// 把会话移动到分组(group 为空/未定义=移出分组)；新组名前插到组顺序=置顶
export function setSessionGroup(id: string, group?: string | null) {
  const name = (group || "").trim();
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.group = name || undefined;
  saveList(l);
  if (name) {
    const g = listGroups();
    if (!g.includes(name)) saveGroups([name, ...g]); // 新组置顶
  }
  pruneGroups();
}

export function setSessionPriority(id: string, priority: number) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.priority = Number.isFinite(priority) ? priority : 0;
  saveList(l);
}

// 历史是否合法：user/assistant 交替 + 每个 tool_use 都有紧跟的配对 tool_result
function isValidHistory(msgs: any[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0 && msgs[i].role === msgs[i - 1].role) return false;
    if (msgs[i].role === "assistant") {
      const ids = (msgs[i].content || []).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      if (ids.length) {
        const nxt = msgs[i + 1];
        if (!nxt || nxt.role !== "user") return false;
        const rids = (nxt.content || []).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
        if (ids.some((id: string) => !rids.includes(id))) return false;
      }
    }
  }
  return true;
}

// 修复被中断搞坏的历史(连续同角色 / 悬空 tool_use / tool_result 错位)，产出合法可继续的序列
function repairHistory(msgs: any[]): any[] {
  const out: any[] = [];
  const ph = (t: string) => ({ type: "text", text: t });
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (m.role === "assistant") {
      if (prev && prev.role === "assistant") out.push({ role: "user", content: [ph("继续")] });
      out.push(m);
      continue;
    }
    const toolResults = (m.content || []).filter((b: any) => b.type === "tool_result");
    const others = (m.content || []).filter((b: any) => b.type !== "tool_result");
    if (prev && prev.role === "assistant" && prev.content.some((b: any) => b.type === "tool_use")) {
      // 紧跟 tool_use：按其 id 顺序补齐 tool_result(有就用，缺就占位)
      const ids = prev.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      const byId = new Map(toolResults.map((r: any) => [r.tool_use_id, r]));
      out.push({
        role: "user",
        content: ids.map(
          (id: string) => byId.get(id) || { type: "tool_result", tool_use_id: id, content: "(已停止)", is_error: true },
        ),
      });
      if (others.length) {
        out.push({ role: "assistant", content: [ph("(已停止)")] });
        out.push({ role: "user", content: others });
      }
    } else {
      if (prev && prev.role === "user") out.push({ role: "assistant", content: [ph("(已停止)")] });
      // 落单 tool_result(前面不是 tool_use)会致 400 → 丢弃，只保留其它内容
      out.push({ role: "user", content: others.length ? others : [ph("(已停止)")] });
    }
  }
  return out;
}

export function loadMessages(id: string): Message[] {
  try {
    const msgs = JSON.parse(readFileSync(join(SDIR, id + ".json"), "utf8"));
    // 只在检测到损坏时修复(干净会话原样返回)，自愈被中断搞坏的历史
    return isValidHistory(msgs) ? msgs : (repairHistory(msgs) as Message[]);
  } catch {
    return [];
  }
}

export function saveSession(
  id: string,
  messages: Message[],
  title: string,
  now: number,
  usage?: SessionMeta["usage"],
) {
  ensure();
  writeFileSync(join(SDIR, id + ".json"), JSON.stringify(messages));
  const all = listSessions();
  const prev = all.find((s) => s.id === id); // 保留已设的分组/优先级，别被每轮落盘抹掉
  const l = all.filter((s) => s.id !== id);
  l.unshift({ id, title, updatedAt: now, usage, group: prev?.group, priority: prev?.priority });
  saveList(l);
}

export function deleteSession(id: string) {
  try {
    rmSync(join(SDIR, id + ".json"));
  } catch {
    /* ignore */
  }
  saveList(listSessions().filter((s) => s.id !== id));
  pruneGroups();
}

// 从首条用户消息推导标题
export function deriveTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          const t = b.text.trim().replace(/\s+/g, " ");
          return t.length > 24 ? t.slice(0, 24) + "…" : t;
        }
      }
    }
  }
  return "新对话";
}
