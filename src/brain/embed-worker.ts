// worker_threads 入口：在独立线程里跑 wasm embedding，主进程不被阻塞、UI 全程可操作。
// 由 embed.ts 的主进程侧 new Worker("embed-worker.cjs") 启动，收发 {id,texts,kind}→{id,v|err}。
import { parentPort, workerData } from "node:worker_threads";
import { embedDirect } from "./embed.js";

if (workerData?.wasmDir) process.env.MINICC_WASM_DIR = workerData.wasmDir;

parentPort?.on("message", async (m: { id: number; texts: string[]; kind: "query" | "passage" }) => {
  try {
    const v = await embedDirect(m.texts, m.kind);
    parentPort?.postMessage({ id: m.id, v });
  } catch (e: any) {
    parentPort?.postMessage({ id: m.id, err: e?.message || String(e) });
  }
});
