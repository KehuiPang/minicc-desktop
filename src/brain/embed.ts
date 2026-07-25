// 本地 embedding：transformers.js + onnx 量化 multilingual-e5-small（384 维，中英通用）。
// 全程离线（模型首次下载后缓存到 ~/.minicc/brain/models），不耗 API token、不出本机。
// 关键容错：模型加载/推理失败一律不抛，返回 null → 上层 recall 自动退化为关键词匹配。
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

const MODEL = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;
export const MODELS_DIR = join(homedir(), ".minicc", "brain", "models");
const ERR_FILE = join(homedir(), ".minicc", "brain", "embed-error.txt");

let extractorPromise: Promise<any> | null = null;
let failed = false; // 加载失败过就别反复重试拖慢每次调用

// 把失败原因落到文件（主进程 console 未必进日志），便于诊断
function dumpErr(where: string, e: any) {
  try {
    mkdirSync(join(homedir(), ".minicc", "brain"), { recursive: true });
    const wd = wasmDir();
    const msg = `[${new Date().toISOString()}] ${where}\nwasmDir=${wd}\nelectron=${!!(process as any).versions?.electron}\nmsg=${e?.message || e}\nstack=${e?.stack || ""}\n`;
    writeFileSync(ERR_FILE, msg);
  } catch {
    /* ignore */
  }
}

// 打包 Electron 里 transformers 的 onnxruntime-node 被 alias 成 onnxruntime-web(wasm)，
// 其 .wasm 文件随 @xenova/transformers/dist 一起解压到 app.asar.unpacked，需把 wasmPaths 指过去。
// 系统 node(CLI/测试)用 onnxruntime-node 原生后端，process.resourcesPath 为空，返回 undefined 不影响。
function wasmDir(): string | undefined {
  if (process.env.MINICC_WASM_DIR) return process.env.MINICC_WASM_DIR;
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (!rp) return undefined;
  const p = join(rp, "app.asar.unpacked", "node_modules", "@xenova", "transformers", "dist");
  return existsSync(p) ? p + "/" : undefined;
}

async function getExtractor(): Promise<any | null> {
  if (failed) return null;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // 国内直连 huggingface.co 基本不通，默认走镜像；可用 HF_ENDPOINT 覆盖
      env.remoteHost = process.env.HF_ENDPOINT || process.env.HF_MIRROR || "https://hf-mirror.com";
      env.cacheDir = MODELS_DIR; // 可写目录（打包后 node_modules 只读）
      env.allowLocalModels = true;
      // Electron: onnxruntime-web(wasm) 需要 .wasm 文件路径 + 单线程(避免打包环境 worker 问题)
      const wd = wasmDir();
      if (wd) {
        env.backends.onnx.wasm.wasmPaths = wd;
        env.backends.onnx.wasm.numThreads = 1;
      }
      return pipeline("feature-extraction", MODEL);
    })().catch((e) => {
      failed = true;
      dumpErr("getExtractor", e);
      console.error("[brain] embedding 模型加载失败，退化为关键词匹配:", e?.message || e);
      return null;
    });
  }
  return extractorPromise;
}

// 预热（在设置里点"启用/下载模型"时调用，避免首次 recall 卡顿）
export async function warmupEmbedder(): Promise<boolean> {
  const ex = await getExtractor();
  return !!ex;
}

export function embeddingReady(): boolean {
  return !failed && !!extractorPromise;
}

// e5 系列要求区分用途前缀：查询用 "query:"，入库文本用 "passage:"
function withPrefix(texts: string[], kind: "query" | "passage"): string[] {
  const p = kind === "query" ? "query: " : "passage: ";
  return texts.map((t) => p + t);
}

// 批量编码；失败返回 null（上层退化）。已 L2 归一化，点积即余弦。
export async function embed(
  texts: string[],
  kind: "query" | "passage" = "passage",
): Promise<number[][] | null> {
  if (!texts.length) return [];
  const ex = await getExtractor();
  if (!ex) return null;
  try {
    const out = await ex(withPrefix(texts, kind), { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  } catch (e: any) {
    dumpErr("embed", e);
    console.error("[brain] embedding 推理失败:", e?.message || e);
    return null;
  }
}

// 余弦相似度（输入需已归一化）
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
