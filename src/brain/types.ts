// minicc Brain：本地概念知识网络的核心类型。
// 设计意图（类比人脑）：不存大段文字，而是把"高价值概念点"抽成节点、
// 用有权重的关系边互相串联；用得越多，节点/边的权重越高，越优先浮现。
// 大段原文（知识宫殿等）作为"长期记忆"另存冷存储，概念节点按需路由过去读。

// 一个概念节点：项目 / 服务器 / 脚本 / 注意事项 / 偏好 / 抽象概念…
export interface BrainNode {
  id: string; // 稳定 id（= 规范化主名，保证同名幂等 upsert）
  name: string; // 主名，如 "figcheck"
  aliases: string[]; // 别名，如 ["图查", "figcheck-api"]
  type: string; // 类型标签：项目/服务器/脚本/注意事项/偏好/概念/命令…（自由文本）
  summary: string; // 一句话摘要
  attrs: Record<string, string>; // 结构化属性：git路径 / 测试环境 / 线上机数 / 部署脚本 …
  docRefs?: string[]; // 关联的冷存储文档块 id（二期知识宫殿导入后填）
  weight: number; // 重要度（命中即强化）
  hits: number; // 命中次数
  createdAt: number;
  updatedAt: number;
  lastHit?: number;
  embedding?: number[]; // 语义向量（对 name+summary+attrs 编码）；无 embedding 时退化为关键词匹配
}

// 一条关系边：figcheck ──部署脚本→ deploy_view_prod.sh
export interface BrainEdge {
  id: string; // 稳定 id（= from|relation|to 规范化）
  from: string; // 源节点 id
  to: string; // 目标节点 id
  relation: string; // 关系名：部署脚本/测试环境/线上机/包含服务/注意事项/关联…
  weight: number; // 关联强度（共同命中即强化）
  hits: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrainGraph {
  version: number;
  nodes: BrainNode[];
  edges: BrainEdge[];
}

export const EMPTY_GRAPH: BrainGraph = { version: 1, nodes: [], edges: [] };
