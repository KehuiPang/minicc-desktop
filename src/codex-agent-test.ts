// 真机验证：Codex 订阅通道下，minicc 完整 agent loop（含工具调用）能否闭环。
// 给一个必须调 bash 的任务，看 模型→function_call→本地执行→回灌→最终答复 全链路。
import { loadConfig } from "./config.js";
import { makeProvider } from "./agent/provider.js";
import { Agent } from "./agent/loop.js";
import { systemPrompt } from "./agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";

process.env.MINICC_PROVIDER = "codex";
const cfg = loadConfig();
console.log(`后端=${cfg.provider} model=${cfg.model} acct=${cfg.codexAccountId.slice(0, 8)}…`);

const cwd = process.cwd();
const agent = new Agent(makeProvider(cfg), systemPrompt(cwd), ALL_TOOLS, { cwd }, TOOL_MAP);

let toolFired = "";
let finalText = "";
await agent.send(
  "请用 bash 执行命令 `echo hello-from-codex-loop`，然后把命令的实际输出原样告诉我。",
  {
    onText: (d) => (finalText += d),
    requestPermission: async () => "allow",
    onToolStart: (_id, name, input) => {
      toolFired = name;
      console.log(`\n[工具调用] ${name} ${JSON.stringify(input)}`);
    },
    onToolEnd: (_id, result) => console.log(`[工具结果] ${result}`),
  },
);

console.log("\n[最终答复]", finalText.trim());
const u = agent.getUsage();
console.log(`[用量] 本上下文≈${u.lastInput} tokens · 累计 输入${u.totalInput}/输出${u.totalOutput}`);
const ok =
  toolFired === "bash" &&
  finalText.includes("hello-from-codex-loop") &&
  u.totalInput > 0 &&
  u.totalOutput > 0;
console.log(
  ok
    ? "\n✅ 全链路闭环：Codex 订阅版驱动 minicc agent loop + 工具调用成功。"
    : `\n⚠️ 未完全闭环（toolFired=${toolFired}）。`,
);
process.exit(ok ? 0 : 1);
