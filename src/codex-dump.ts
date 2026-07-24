// dump Codex /responses 的全部响应头（找额度/限额字段）+ 扫 SSE 里 rate_limit 类事件。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const auth = JSON.parse(readFileSync(`${homedir()}/.codex/auth.json`, "utf8"));
const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: randomUUID(),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "codex_cli_rs/0.0.0",
  },
  body: JSON.stringify({
    model: "gpt-5.5",
    instructions: "x",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
  }),
});

console.log("HTTP", res.status);
console.log("==== 全部响应头 ====");
res.headers.forEach((v, k) => console.log(`${k}: ${v}`));

console.log("\n==== 扫 SSE 里 rate/limit/usage 事件 ====");
if (res.body) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const block of parts) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try {
          const ev = JSON.parse(d);
          const s = JSON.stringify(ev);
          if (/rate|limit|usage|reset|quota|credit/i.test(s)) {
            console.log(`[${ev.type}] ${s.slice(0, 600)}`);
          }
        } catch {
          /* skip */
        }
      }
    }
  }
}
console.log("\n(dump 结束)");
