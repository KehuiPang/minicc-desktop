import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveContextWindow } from "./context-window.js";
import { loadConfig } from "./config.js";

test("Codex uses per-model maximum, with defaults and validated overrides", () => {
  const dir = mkdtempSync(`${tmpdir()}/minicc-context-`);
  const path = `${dir}/models.json`;
  try {
    writeFileSync(path, JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
      { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000 },
      { slug: "default-only", context_window: 200000 },
    ] }));
    const r = resolveContextWindow("gpt-6.1-sol", "codex", "", path);
    assert.equal(r.contextWindow, 872000);
    assert.equal(r.contextWindowSource, "codex-metadata");
    assert.equal(r.effectiveContextWindowPercent, 95);
    assert.equal(resolveContextWindow("gpt-5.5", "codex", "", path).contextWindow, 272000);
    assert.equal(resolveContextWindow("default-only", "codex", "", path).contextWindow, 200000);
    assert.equal(resolveContextWindow("unknown", "codex", "", path).contextWindowSource, "estimate");
    assert.equal(resolveContextWindow("gpt-6.1-sol", "codex", "900000", path).contextWindow, 900000);
    for (const value of ["-1", "Infinity", "1.5", "NaN"]) {
      assert.equal(resolveContextWindow("gpt-6.1-sol", "codex", value, path).contextWindow, 872000);
    }
    writeFileSync(path, "invalid json");
    assert.equal(resolveContextWindow("gpt-6.1-sol", "codex", "", path).contextWindowSource, "estimate");
    assert.equal(resolveContextWindow("gpt-6.1-sol", "openai", "", path).contextWindowSource, "estimate");
  } finally { rmSync(dir, { recursive: true }); }
});

test("loadConfig preserves explicit large windows and derives compaction threshold", () => {
  const env = { ...process.env };
  try {
    process.env.MINICC_PROVIDER = "codex";
    process.env.MINICC_MODEL = "gpt-6.1-sol";
    process.env.MINICC_CONTEXT_WINDOW = "872000";
    delete process.env.MINICC_COMPACT_THRESHOLD;
    const cfg = loadConfig();
    assert.equal(cfg.contextWindow, 872000);
    assert.equal(cfg.compactThreshold, 697600);
  } finally { process.env = env; }
});
