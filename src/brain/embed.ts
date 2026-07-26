// 本地 embedding：transformers.js + onnx 量化 multilingual-e5-small（384 维，中英通用）。
// 关键：Electron 主进程里推理会占满主线程、卡死 UI，所以主进程改走 worker_threads 后台跑；
// worker 内部与系统 node(测试)则直接推理。全程离线、失败返回 null（上层退化关键词）。
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

const MODEL = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;
export const MODELS_DIR = join(homedir(), ".wuwei", "brain", "models");
const ERR_FILE = join(homedir(), ".wuwei", "brain", "embed-error.txt");

let extractorPromise: Promise<any> | null = null;
let failed = false;

function dumpErr(where: string, e: any) {
  try {
    mkdirSync(join(homedir(), ".wuwei", "brain"), { recursive: true });
    const msg = `[${new Date().toISOString()}] ${where}\nwasmDir=${wasmDir()}\nmsg=${e?.message || e}\nstack=${e?.stack || ""}\n`;
    writeFileSync(ERR_FILE, msg);
  } catch {
    /* ignore */
  }
}

// wasm 文件目录：打包 Electron 里 onnxruntime-web 的 .wasm 随 @xenova/transformers/dist 解压。
// MINICC_WASM_DIR 优先（worker/自测用）。系统 node 用原生后端，返回 undefined 不影响。
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
      env.remoteHost = process.env.HF_ENDPOINT || process.env.HF_MIRROR || "https://hf-mirror.com";
      env.cacheDir = MODELS_DIR;
      env.allowLocalModels = true;
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

function withPrefix(texts: string[], kind: "query" | "passage"): string[] {
  const p = kind === "query" ? "query: " : "passage: ";
  return texts.map((t) => p + t);
}

// 直接推理（worker 内部 / 系统 node 用）
export async function embedDirect(
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

// —— 主进程：把推理丢给 worker_threads 后台跑，不阻塞 UI ——
let worker: any = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// 解析 embed-worker.cjs 的真实位置。打包后 embed.ts 会被 rollup 拆进 out/main/chunks/，
// 而 worker 作为独立入口输出在 out/main/embed-worker.cjs(上一级)，直接 join(__dirname,...) 会 404。
// 逐个候选路径探测存在即用,兼容 dev(未拆分)/打包(chunks 子目录)两种布局。
function resolveWorkerPath(): string {
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    join(__dirname, "embed-worker.cjs"), // dev / 未拆分:与本文件同目录
    join(__dirname, "..", "embed-worker.cjs"), // 打包:本文件在 chunks/,worker 在上一级 out/main/
    ...(rp ? [join(rp, "app.asar", "out", "main", "embed-worker.cjs")] : []), // 兜底:直指 asar 内固定位置
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0]; // 都不存在也返回首选,让 Worker 抛出明确的 not found 便于排查
}

function getWorker(): any {
  if (worker) return worker;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Worker } = require("node:worker_threads");
  const workerPath = resolveWorkerPath();
  worker = new Worker(workerPath, { workerData: { wasmDir: wasmDir() } });
  worker.on("message", (m: any) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.err) p.reject(new Error(m.err));
    else p.resolve(m.v);
  });
  worker.on("error", (e: any) => {
    dumpErr("worker", e);
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  });
  return worker;
}

function embedViaWorker(texts: string[], kind: "query" | "passage"): Promise<number[][] | null> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, texts, kind });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  }).catch((e) => {
    dumpErr("embedViaWorker", e);
    return null;
  }) as Promise<number[][] | null>;
}

// 是否该走 worker：仅 Electron 主线程（worker 内 isMainThread=false 走 direct；系统 node 无 electron 走 direct）
function useWorker(): boolean {
  return !!(process as any).versions?.electron && isMainThread;
}

// 对外统一入口：自动路由（主进程→worker 后台；worker/node→直接）
export async function embed(
  texts: string[],
  kind: "query" | "passage" = "passage",
): Promise<number[][] | null> {
  if (!texts.length) return [];
  return useWorker() ? embedViaWorker(texts, kind) : embedDirect(texts, kind);
}

// 预热：主进程也走 worker（触发 worker 加载模型），失败则视为不可用
export async function warmupEmbedder(): Promise<boolean> {
  const v = await embed(["warmup"], "query");
  return !!v;
}

export function embeddingReady(): boolean {
  return !failed && (!!extractorPromise || !!worker);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
