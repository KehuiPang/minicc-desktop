// 无为账号会话持久化（B2：明文 JSON。B3 将改 Electron safeStorage/DPAPI 加密）。
// 存 ~/.wuwei/auth.json，与 CLI 端 auth-client.ts 同路径同结构（access_token/refresh_token/expires_at 秒），三端共享。
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WuweiSession } from "./wuwei-auth.js";

const DIR = join(homedir(), ".wuwei");
const FILE = join(DIR, "auth.json");

export function saveWuweiSession(s: WuweiSession): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    FILE,
    JSON.stringify(
      { access_token: s.accessToken, refresh_token: s.refreshToken, expires_at: Math.floor(s.expiresAt / 1000) },
      null,
      2,
    ),
    "utf8",
  );
  try {
    chmodSync(FILE, 0o600); // Windows 无效 → B3 用 safeStorage 加固
  } catch {
    /* ignore */
  }
}

export function loadWuweiSession(): WuweiSession | null {
  try {
    if (!existsSync(FILE)) return null;
    const d = JSON.parse(readFileSync(FILE, "utf8")) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    if (!d.access_token) return null;
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? "",
      expiresAt: (d.expires_at || 0) * 1000,
    };
  } catch {
    return null;
  }
}

export function clearWuweiSession(): void {
  try {
    if (existsSync(FILE)) writeFileSync(FILE, "{}", "utf8");
  } catch {
    /* ignore */
  }
}
