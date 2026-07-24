// 本地验证：不用真实凭证，用 mock server 断言"订阅版 OAuth 请求"组装正确 + 响应解析正确。
// 起一个假 Anthropic 端点，捕获请求头与 body，返回一段合法 SSE，全链路走一遍。
import http from "node:http";
import { makeProvider } from "./agent/provider.js";
import { loadConfig } from "./config.js";
import type { Message } from "./types.js";

const SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OAUTH-OK" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

let captured: { headers: http.IncomingHttpHeaders; body: any } | null = null;

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    captured = { headers: req.headers, body: JSON.parse(data || "{}") };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(SSE);
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;

// 配成：anthropic 后端 + OAuth token + 指向 mock 端点
process.env.MINICC_PROVIDER = "anthropic";
process.env.MINICC_OAUTH_TOKEN = "test-access-token";
process.env.MINICC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.MINICC_MODEL = "claude-test";

const cfg = loadConfig();
const provider = makeProvider(cfg);

let text = "";
const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];
const result = await provider.complete("我的系统提示词", messages, [], {
  onText: (d) => (text += d),
});
server.close();

// —— 断言 ——
const h = captured!.headers;
const body = captured!.body;
const checks: [string, boolean][] = [
  ["authMode=oauth", cfg.authMode === "oauth"],
  ["Authorization: Bearer test-access-token", h["authorization"] === "Bearer test-access-token"],
  ["无 x-api-key", h["x-api-key"] === undefined],
  ["anthropic-beta 含 oauth", String(h["anthropic-beta"] ?? "").includes("oauth")],
  ["system 是数组", Array.isArray(body.system)],
  [
    "system[0] 为 Claude Code 身份",
    body.system?.[0]?.text === "You are Claude Code, Anthropic's official CLI for Claude.",
  ],
  ["system[1] 为我们的提示词", body.system?.[1]?.text === "我的系统提示词"],
  ["响应文本解析为 OAUTH-OK", text === "OAUTH-OK"],
  ["stopReason=end_turn", result.stopReason === "end_turn"],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nOAUTH MOCK PASS ✅ 订阅版请求方式本地调通" : "\nOAUTH MOCK FAIL ❌");
process.exit(ok ? 0 : 1);
