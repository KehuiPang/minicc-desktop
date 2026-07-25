// 打包环境自测：esbuild 以与主进程相同条件(cjs+alias+external sharp)打包后，
// electron-node 里真实跑 embedding 全链路。测通过再发版。
import { warmupEmbedder, embed, cosine } from "./embed.js";

(async () => {
  console.log("[selftest] MINICC_WASM_DIR =", process.env.MINICC_WASM_DIR || "(未设)");
  const ok = await warmupEmbedder();
  console.log("[selftest] warmup =", ok);
  if (!ok) { console.log("[selftest] ✗ 预热失败"); process.exit(1); }
  const v = await embed(["figcheck 怎么部署", "figcheck 是图像查重项目", "今天天气不错"], "passage");
  if (!v) { console.log("[selftest] ✗ embed 返回 null"); process.exit(1); }
  console.log("[selftest] 维度 =", v[0].length);
  console.log("[selftest] 相关(部署↔查重) =", cosine(v[0], v[1]).toFixed(3));
  console.log("[selftest] 无关(部署↔天气) =", cosine(v[0], v[2]).toFixed(3));
  console.log("[selftest] ✓ 打包环境 embedding 全链路通过");
})();
