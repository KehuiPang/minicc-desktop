// 临时探针：验证本地 embedding 能否下载+运行(测完删)
import { pipeline, env } from "@xenova/transformers";

// 允许通过环境变量切 HF 镜像(国内直连慢时用 hf-mirror.com)
if (process.env.HF_MIRROR) env.remoteHost = process.env.HF_MIRROR;
env.allowLocalModels = false;

const t0 = Date.now();
console.log("加载模型 multilingual-e5-small … host=", env.remoteHost);
const extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
console.log("模型就绪，用时", ((Date.now() - t0) / 1000).toFixed(1), "s");

const texts = ["query: figcheck 怎么部署", "passage: figcheck 是图像查重项目，部署脚本在 delopy_batch", "passage: 今天天气不错"];
const out = await extractor(texts, { pooling: "mean", normalize: true });
console.log("输出维度 dims=", out.dims);

// 手算余弦(已 normalize，点积即余弦)
const v = out.tolist();
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
console.log("query↔figcheck部署 相似度:", dot(v[0], v[1]).toFixed(4));
console.log("query↔天气   相似度:", dot(v[0], v[2]).toFixed(4));
