// 账号：从 ~/.codex/auth.json 读取当前 ChatGPT 登录态并解析邮箱；登出=删凭证。
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH = join(homedir(), ".codex", "auth.json");

function decodeJwtEmail(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return json.email || json["https://api.openai.com/profile"]?.email || null;
  } catch {
    return null;
  }
}

export interface Account {
  loggedIn: boolean;
  email: string | null;
}

export function getAccount(): Account {
  try {
    const auth = JSON.parse(readFileSync(AUTH, "utf8"));
    const email = auth?.tokens?.id_token ? decodeJwtEmail(auth.tokens.id_token) : null;
    return { loggedIn: !!auth?.tokens?.access_token, email };
  } catch {
    return { loggedIn: false, email: null };
  }
}

export function logout(): void {
  try {
    rmSync(AUTH);
  } catch {
    /* ignore */
  }
}
