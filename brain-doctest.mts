// 文档冷存储链路验证（测完清理）
import * as brain from "./src/brain/index.js";
import { searchDocs } from "./src/brain/docs.js";
import { DOCS_FILE } from "./src/brain/docs.js";
import { rmSync } from "node:fs";

const dir = process.env.HOME + "/Documents/tanxun/知识宫殿/figcheck";
console.log("索引目录:", dir);
const t0 = Date.now();
const idx = await brain.buildDocs(dir, (p) => {
  if (p.phase === "embed" && p.done! % 128 === 0) console.log(`  向量化 ${p.done}/${p.total}`);
});
console.log(`分块 ${idx.chunks.length} 块，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

for (const q of ["figcheck 部署脚本在哪", "milvus 集群规模", "今天午饭吃什么"]) {
  const hits = await searchDocs(q, 3);
  console.log(`\n【${q}】命中 ${hits.length}:`);
  for (const h of hits) console.log(`  ${h.score.toFixed(3)} ${h.file} 〖${h.headingPath}〗`);
}

rmSync(DOCS_FILE, { force: true });
console.log("\n[测试索引已清理]");
