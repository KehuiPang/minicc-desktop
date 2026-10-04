// 运行配置：从环境变量读取，决定接哪个模型后端。
// 四条路：
//   1) Claude API key（provider=anthropic, authMode=api-key）—— ANTHROPIC_API_KEY(sk-ant-...)
//   2) Claude 订阅 OAuth（provider=anthropic, authMode=oauth）—— MINICC_OAUTH_TOKEN
//   3) OpenAI 兼容端点（provider=openai）—— MINICC_BASE_URL + MINICC_MODEL（本地 vLLM 等）
//   4) Codex 订阅版（provider=codex）—— ChatGPT 登录，走 Responses API + chatgpt.com/backend-api/codex
//      凭证优先取 env(CODEX_ACCESS_TOKEN/CODEX_ACCOUNT_ID)，否则读 ~/.codex/auth.json。
//      真机验证：model 必须用主线名(如 gpt-5.5)，gpt-5*-codex 后缀在订阅通道被拒。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveContextWindow, type ContextInfo } from "./context-window.js";

export type AuthMode = "api-key" | "oauth";

export interface Config extends ContextInfo {
  provider: "anthropic" | "openai" | "codex";
  authMode: AuthMode;
  model: string;
  apiKey: string;
  oauthToken: string;
  baseUrl?: string;
  vision?: boolean; // 强制按多模态处理(自建端点模型名不含 vl 时用)；MINICC_VISION=1
  disableTools?: boolean; // 不发工具(某些自建 vLLM 未开 --enable-auto-tool-choice 会 400)；MINICC_NO_TOOLS=1
  maxTokens: number;
  effort?: string; // 思考深度 low/medium/high/xhigh/max(空=不发参数,走各平台默认)；MINICC_EFFORT
  anthropicBeta: string;
  // Codex 订阅
  codexToken: string;
  codexAccountId: string;
  codexEndpoint: string;
  // 上下文自动压缩
  contextWindow: number; // 该模型的上下文窗口(用于占用条 + 计算压缩阈值)
  compactThreshold: number; // 上一轮 input tokens 超过此值就压缩
  keepRecentTurns: number; // 压缩时保留最近多少条原始消息
}

// 上下文容量统一由 context-window.ts 解析，显示与压缩共用同一结果。

// 单次请求的输出上限(max_tokens)。历史死写成 8192，长回复(整份文档/整文件重写)会顶到上限被截在半句，
// 且 loop 拿到 stop_reason=max_tokens 也不续写→尾巴被静默切掉。这里按模型给到各家实际支持的输出上限。
// 注意：provider 里已有护栏(maxTokens>=contextWindow 时不发 max_tokens，让服务端自适应)，故对大窗口模型放心给大值。
function maxTokensFor(model: string): number {
  const m = model.toLowerCase();
  if (/claude-(sonnet|fable|mythos)/.test(m)) return 64_000; // Sonnet 系列支持 64K 输出
  if (/claude-opus/.test(m)) return 32_000;
  if (/claude-haiku/.test(m)) return 32_000;
  if (/gpt-5|gpt-4\.1|\bo3\b|\bo4/.test(m)) return 32_000;
  if (/deepseek-v4/.test(m)) return 32_000;
  if (/glm-5|glm-4/.test(m)) return 32_000;
  if (/\bk3\b|kimi/.test(m)) return 32_000;
  if (/qwen|doubao|hunyuan|grok|minimax/.test(m)) return 32_000;
  if (/moonshot-v1-8k/.test(m)) return 8_192; // 小窗口本地/旧模型保守
  return 8_192; // 未知/本地小窗口 vLLM：保守，护栏会在越界时改成服务端自适应
}

function pick(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

// 读取 Codex 凭证：优先 env，其次 ~/.codex/auth.json（ChatGPT 登录写入）
function loadCodexCreds(): { token: string; accountId: string } {
  const envToken = pick("CODEX_ACCESS_TOKEN");
  const envAcct = pick("CODEX_ACCOUNT_ID");
  if (envToken && envAcct) return { token: envToken, accountId: envAcct };
  try {
    const auth = JSON.parse(readFileSync(`${homedir()}/.codex/auth.json`, "utf8"));
    return {
      token: envToken || auth?.tokens?.access_token || "",
      accountId: envAcct || auth?.tokens?.account_id || "",
    };
  } catch {
    return { token: envToken, accountId: envAcct };
  }
}

export function loadConfig(): Config {
  const oauthToken = pick("MINICC_OAUTH_TOKEN");
  const explicit = pick("MINICC_PROVIDER");

  // 后端推断优先级：显式 > 本地端点 > 有 Claude 凭证 > 有 Codex 登录 > 默认 anthropic
  const hasClaudeCred = !!pick("ANTHROPIC_API_KEY") || !!oauthToken;
  const hasCodexAuth = existsSync(`${homedir()}/.codex/auth.json`);
  const provider: Config["provider"] =
    explicit === "openai" || explicit === "anthropic" || explicit === "codex"
      ? (explicit as Config["provider"])
      : pick("MINICC_BASE_URL")
        ? "openai"
        : hasClaudeCred
          ? "anthropic"
          : hasCodexAuth
            ? "codex"
            : "anthropic";

  const authMode: AuthMode =
    provider === "anthropic" && oauthToken ? "oauth" : "api-key";

  const codex = provider === "codex" ? loadCodexCreds() : { token: "", accountId: "" };

  const model =
    pick("MINICC_MODEL") ||
    (provider === "anthropic"
      ? "claude-sonnet-5"
      : provider === "codex"
        ? "gpt-5.5"
        : "qwen3-coder");

  const apiKey =
    provider === "anthropic" ? pick("ANTHROPIC_API_KEY") : pick("MINICC_API_KEY", "not-needed");

  const contextInfo = resolveContextWindow(model, provider, pick("MINICC_CONTEXT_WINDOW"));
  const ctxWindow = contextInfo.contextWindow;

  return {
    provider,
    authMode,
    model,
    apiKey,
    oauthToken,
    baseUrl: pick("MINICC_BASE_URL") || undefined,
    vision: /^(1|true|yes)$/i.test(pick("MINICC_VISION", "")),
    disableTools: /^(1|true|yes)$/i.test(pick("MINICC_NO_TOOLS", "")),
    maxTokens: Number(pick("MINICC_MAX_TOKENS")) || maxTokensFor(model),
    effort: pick("MINICC_EFFORT") || undefined,
    anthropicBeta: pick("MINICC_ANTHROPIC_BETA", "oauth-2025-04-20"),
    codexToken: codex.token,
    codexAccountId: codex.accountId,
    codexEndpoint: pick(
      "MINICC_CODEX_ENDPOINT",
      "https://chatgpt.com/backend-api/codex/responses",
    ),
    ...contextInfo,
    // 阈值默认=窗口的 80%(留 20% 余量再压缩)；env 可显式覆盖
    compactThreshold: pick("MINICC_COMPACT_THRESHOLD")
      ? Number(pick("MINICC_COMPACT_THRESHOLD"))
      : Math.floor(ctxWindow * 0.8),
    keepRecentTurns: Number(pick("MINICC_KEEP_RECENT", "12")),
  };
}
