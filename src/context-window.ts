import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface ContextInfo {
  contextWindow: number;
  contextWindowSource: "override" | "codex-metadata" | "model-table" | "estimate";
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
}
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// 用户选择采用 Codex 元数据中的最大窗口；通道实际接受上限仍由服务端决定。
export function resolveContextWindow(model: string, provider: string, override?: string,
  cachePath = `${homedir()}/.codex/models_cache.json`): ContextInfo {
  const explicit = Number(override);
  if (positive(explicit)) return { contextWindow: explicit, contextWindowSource: "override" };
  if (provider === "codex") {
    try {
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      const entry = Array.isArray(cache.models) && cache.models.find((x: any) => x.slug === model);
      if (entry && positive(entry.context_window)) {
        return {
          contextWindow: positive(entry.max_context_window) && entry.max_context_window >= entry.context_window
            ? entry.max_context_window : entry.context_window,
          contextWindowSource: "codex-metadata",
          maxContextWindow: positive(entry.max_context_window) ? entry.max_context_window : undefined,
          effectiveContextWindowPercent: positive(entry.effective_context_window_percent) && entry.effective_context_window_percent <= 100
            ? entry.effective_context_window_percent : undefined,
        };
      }
    } catch { /* 缺失/损坏缓存：保守估算，不能冒充已核实容量。 */ }
    return { contextWindow: 128_000, contextWindowSource: "estimate" };
  }
  const m = model.toLowerCase();
  const rules: [RegExp, number][] = [
    [/claude-(opus|sonnet|fable|mythos)/, 1_000_000], [/claude-haiku/, 200_000],
    [/deepseek-v4|minimax-m3/, 1_000_000], [/minimax/, 200_000],
    [/^gpt-4\.1(?:-|$)/, 1_047_576], [/^o3(?:-|$)|^o4-mini(?:-|$)/, 200_000],
    [/^gpt-4o(?:-|$)/, 128_000],
    [/qwen3?[.-]?(max|7)|qwen-max|qwen-plus|doubao/, 256_000],
    [/glm-5/, 1_000_000], [/glm-4/, 200_000],
    [/moonshot-v1-8k/, 8_192], [/moonshot-v1-32k/, 32_000], [/moonshot-v1-128k/, 128_000],
    [/\bk3\b|kimi-k3/, 1_000_000], [/kimi-for-coding|kimi|hunyuan/, 256_000],
    [/grok-4\.[35]/, 1_000_000], [/grok/, 256_000],
  ];
  const rule = rules.find(([re]) => re.test(m));
  return { contextWindow: rule?.[1] ?? 128_000, contextWindowSource: rule ? "model-table" : "estimate" };
}
