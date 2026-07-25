// 本地密钥管理器：加密保险箱 + 分层检测 + 双向脱敏 + 环境变量注入。
// 目标：敏感密钥统一本地加密存储；发给模型前用占位符替换、模型永远看不到明文；
// 本机工具执行时通过环境变量/占位符回填，任务照跑。
import { safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const VAULT_PATH = join(homedir(), ".minicc", "secrets.json");

// 占位符：用不常见的括号包裹，模型极少会去改写它，回填走精确匹配
const PH_OPEN = "⟦secret:";
const PH_CLOSE = "⟧";
function placeholderOf(name: string): string {
  return `${PH_OPEN}${name}${PH_CLOSE}`;
}

export interface SecretEntry {
  id: string;
  name: string; // 唯一名，用作占位符与默认环境变量名
  envVar: string; // 注入子进程的环境变量名（可与 name 不同）
  enc: string; // safeStorage 加密后的 base64；明文永不落盘
  note?: string;
  createdAt: number;
}

// 对外展示用（掩码，不含明文/密文）
export interface SecretView {
  id: string;
  name: string;
  envVar: string;
  masked: string;
  note?: string;
  createdAt: number;
}

interface VaultFile {
  entries: SecretEntry[];
}

let cache: VaultFile | null = null;

function load(): VaultFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(VAULT_PATH, "utf8"));
    cache = { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch {
    cache = { entries: [] };
  }
  return cache;
}

function persist() {
  if (!cache) return;
  mkdirSync(dirname(VAULT_PATH), { recursive: true });
  writeFileSync(VAULT_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // 极端兜底：系统钥匙串不可用时不明文落盘，宁可报错
    throw new Error("系统加密不可用(safeStorage)，无法安全存储密钥");
  }
  return safeStorage.encryptString(plain).toString("base64");
}

function decrypt(enc: string): string {
  return safeStorage.decryptString(Buffer.from(enc, "base64"));
}

function mask(plain: string): string {
  if (plain.length <= 8) return "•".repeat(plain.length);
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}

// 归一化名字：转成合法的占位符/环境变量片段
function normName(raw: string): string {
  const n = (raw || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return n || "secret";
}

// ---- 对外：视图列表（掩码） ----
export function listSecrets(): SecretView[] {
  return load().entries.map((e) => {
    let masked = "••••";
    try {
      masked = mask(decrypt(e.enc));
    } catch {
      /* 解密失败(换机/钥匙串变动) */
      masked = "⚠ 无法解密";
    }
    return { id: e.id, name: e.name, envVar: e.envVar, masked, note: e.note, createdAt: e.createdAt };
  });
}

// ---- 增：value 为明文，立即加密；名字/环境变量名唯一化 ----
export function addSecret(input: { name?: string; envVar?: string; value: string; note?: string }): SecretView {
  const v = load();
  const value = String(input.value ?? "");
  if (!value) throw new Error("密钥值为空");
  let name = normName(input.name || "secret");
  // 名字撞车则加后缀，保证占位符唯一
  const used = new Set(v.entries.map((e) => e.name));
  if (used.has(name)) {
    let i = 2;
    while (used.has(`${name}_${i}`)) i++;
    name = `${name}_${i}`;
  }
  const envVar = normName(input.envVar || name).toUpperCase();
  const entry: SecretEntry = {
    id: randomUUID(),
    name,
    envVar,
    enc: encrypt(value),
    note: input.note?.trim() || undefined,
    createdAt: Date.now(),
  };
  v.entries.push(entry);
  persist();
  return { id: entry.id, name, envVar, masked: mask(value), note: entry.note, createdAt: entry.createdAt };
}

// ---- 改：可改 name/envVar/note/value（value 传空则不动） ----
export function updateSecret(id: string, patch: { name?: string; envVar?: string; note?: string; value?: string }): void {
  const v = load();
  const e = v.entries.find((x) => x.id === id);
  if (!e) throw new Error("密钥不存在");
  if (patch.name != null) e.name = normName(patch.name);
  if (patch.envVar != null) e.envVar = normName(patch.envVar).toUpperCase();
  if (patch.note != null) e.note = patch.note.trim() || undefined;
  if (patch.value) e.enc = encrypt(String(patch.value));
  persist();
}

export function deleteSecret(id: string): void {
  const v = load();
  v.entries = v.entries.filter((x) => x.id !== id);
  persist();
}

// ---- 从 .env 文本批量导入（KEY=VALUE 行） ----
export function importEnv(text: string): number {
  let n = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let val = m[2].trim();
    // 去掉包裹引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!val) continue;
    try {
      addSecret({ name: m[1].toLowerCase(), envVar: m[1].toUpperCase(), value: val });
      n++;
    } catch {
      /* 跳过 */
    }
  }
  return n;
}

// 明文值缓存（仅内存，用于脱敏/回填/env 注入）
function plaintextMap(): { byValue: Map<string, SecretEntry>; entries: { e: SecretEntry; plain: string }[] } {
  const byValue = new Map<string, SecretEntry>();
  const entries: { e: SecretEntry; plain: string }[] = [];
  for (const e of load().entries) {
    try {
      const plain = decrypt(e.enc);
      if (plain) {
        byValue.set(plain, e);
        entries.push({ e, plain });
      }
    } catch {
      /* 忽略解不开的 */
    }
  }
  // 长值优先替换，避免短值是长值子串导致的错替
  entries.sort((a, b) => b.plain.length - a.plain.length);
  return { byValue, entries };
}

// ---- 脱敏：把已入库的明文密钥替换成占位符（精确匹配，静默） ----
export function redact(text: string): { text: string; hit: boolean } {
  if (!text) return { text, hit: false };
  const { entries } = plaintextMap();
  let out = text;
  let hit = false;
  for (const { e, plain } of entries) {
    if (plain.length < 6) continue; // 太短不做全局替换，避免误伤
    if (out.includes(plain)) {
      out = out.split(plain).join(placeholderOf(e.name));
      hit = true;
    }
  }
  return { text: out, hit };
}

// ---- 回填：把占位符换回真实明文（用于本机工具执行/写文件） ----
export function rehydrate(text: string): string {
  if (!text || !text.includes(PH_OPEN)) return text;
  let out = text;
  for (const e of load().entries) {
    const ph = placeholderOf(e.name);
    if (out.includes(ph)) {
      try {
        out = out.split(ph).join(decrypt(e.enc));
      } catch {
        /* 解不开就留占位符 */
      }
    }
  }
  return out;
}

// ---- 环境变量注入表：给本机 bash 子进程用 ----
export function envForTools(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of load().entries) {
    if (!e.envVar) continue;
    try {
      env[e.envVar] = decrypt(e.enc);
    } catch {
      /* skip */
    }
  }
  return env;
}

// ---- 检测：找出「尚未入库」的疑似新密钥（给发送前确认弹窗用） ----
const DETECTORS: { kind: string; re: RegExp }[] = [
  { kind: "openai", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-akid", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { kind: "google", re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { kind: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "generic-token", re: /\bsk-[A-Za-z0-9]{10,}\b/g },
];

export interface Candidate {
  value: string;
  masked: string;
  kind: string;
  suggestedName: string;
}

export function detect(text: string): Candidate[] {
  if (!text) return [];
  const { byValue } = plaintextMap();
  const found = new Map<string, string>(); // value -> kind
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = d.re.exec(text))) {
      const val = m[0];
      if (byValue.has(val)) continue; // 已入库的交给 redact，不再提示
      if (!found.has(val)) found.set(val, d.kind);
    }
  }
  return [...found.entries].map(([value, kind]) => ({
    value,
    masked: mask(value),
    kind,
    suggestedName: `${kind.replace(/-/g, "_")}_key`,
  }));
}

// 系统提示：告诉模型密钥都在本地保险箱/环境变量，它无需知道明文
export const SECRETS_SYSTEM_NOTE =
  `\n\n## 本地密钥管理\n所有敏感密钥由本地密钥管理器 + 环境变量统一加密管理，你无需、也不会看到具体明文——凡是 ${PH_OPEN}名字${PH_CLOSE} 形式的占位符都是被脱敏的真实密钥，本地执行时会自动回填。` +
  `需要用到密钥时：优先在 bash 里用环境变量(如 $OPENAI_API_KEY)引用，minicc 会把真实值注入子进程；或直接沿用占位符，写入文件/命令时本地会替换。不要向用户索要或试图打印明文密钥。`;
