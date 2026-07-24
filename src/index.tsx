// minicc 终端入口（P3：Ink TUI）。构造 Agent，渲染 <App/>。
import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { makeProvider } from "./agent/provider.js";
import { Agent } from "./agent/loop.js";
import { systemPrompt } from "./agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import { App } from "./ui/app.js";

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail("minicc 需要在交互式终端(TTY)里运行。请打开 Terminal / iTerm，直接运行 minicc-pro。");
}

const cfg = loadConfig();
if (cfg.provider === "codex" && (!cfg.codexToken || !cfg.codexAccountId)) {
  fail(
    "未取到 Codex 凭证。请先用 Codex app/CLI 以 ChatGPT 登录（~/.codex/auth.json），" +
      "或 export CODEX_ACCESS_TOKEN 和 CODEX_ACCOUNT_ID。",
  );
}
if (cfg.provider === "anthropic" && cfg.authMode === "api-key" && !cfg.apiKey) {
  fail(
    "未设置凭证。三选一：\n" +
      "  · API key : export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  · 订阅OAuth: export MINICC_OAUTH_TOKEN=<access token>\n" +
      "  · 本地模型 : export MINICC_BASE_URL=http://<主机>:8000/v1 MINICC_MODEL=<名>",
  );
}

const cwd = process.cwd();
const agent = new Agent(makeProvider(cfg), systemPrompt(cwd), ALL_TOOLS, { cwd }, TOOL_MAP, {
  compactThreshold: cfg.compactThreshold,
  keepRecent: cfg.keepRecentTurns,
});

const backend = cfg.provider === "anthropic" ? `anthropic/${cfg.authMode}` : cfg.provider;
render(<App agent={agent} provider={backend} model={cfg.model} />);
