// Brain 图的持久化 + 纯函数增删改查 + 权重强化。
// 存储：~/.minicc/brain/graph.json（单文件；节点/边规模在千级，JSON 足够）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrainGraph, BrainNode, BrainEdge } from "./types.js";
import { EMPTY_GRAPH } from "./types.js";

export const BRAIN_DIR = join(homedir(), ".minicc", "brain");
export const GRAPH_FILE = join(BRAIN_DIR, "graph.json");

// 规范化成稳定 key：trim + 小写 + 折叠内部空白（中文原样保留）
export function normId(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function loadGraph(): BrainGraph {
  try {
    const g = JSON.parse(readFileSync(GRAPH_FILE, "utf8"));
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { ...EMPTY_GRAPH };
    return g as BrainGraph;
  } catch {
    return { ...EMPTY_GRAPH };
  }
}

export function saveGraph(g: BrainGraph): void {
  mkdirSync(BRAIN_DIR, { recursive: true });
  writeFileSync(GRAPH_FILE, JSON.stringify(g), "utf8");
}

// 按 id / 主名 / 别名（均规范化）定位节点
export function findNode(g: BrainGraph, key: string): BrainNode | undefined {
  const k = normId(key);
  return g.nodes.find(
    (n) => n.id === k || normId(n.name) === k || n.aliases.some((a) => normId(a) === k),
  );
}

export interface NodeInput {
  name: string;
  type?: string;
  summary?: string;
  aliases?: string[];
  attrs?: Record<string, string>;
}

// upsert：同名（或命中别名）则合并，否则新建。不计算 embedding（由上层门面填）。
// 返回 [节点, 是否新建]。
export function upsertNode(g: BrainGraph, input: NodeInput): [BrainNode, boolean] {
  const now = Date.now();
  let node = findNode(g, input.name);
  if (node) {
    if (input.type) node.type = input.type;
    if (input.summary) node.summary = input.summary;
    if (input.aliases?.length) {
      const set = new Set([...node.aliases.map(normId)]);
      for (const a of input.aliases) if (!set.has(normId(a)) && normId(a) !== node.id) node.aliases.push(a);
    }
    if (input.attrs) node.attrs = { ...node.attrs, ...input.attrs };
    node.updatedAt = now;
    node.embedding = undefined; // 内容变了 → 作废旧向量，上层重算
    return [node, false];
  }
  node = {
    id: normId(input.name),
    name: input.name.trim(),
    aliases: (input.aliases || []).filter((a) => normId(a) !== normId(input.name)),
    type: input.type || "概念",
    summary: input.summary || "",
    attrs: input.attrs || {},
    weight: 1,
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  g.nodes.push(node);
  return [node, true];
}

function edgeId(fromId: string, relation: string, toId: string): string {
  return `${fromId}|${normId(relation)}|${toId}`;
}

// 建/强化一条关系边；from/to 用节点主名或别名解析。缺任一端则不建，返回 undefined。
export function upsertEdge(
  g: BrainGraph,
  fromKey: string,
  relation: string,
  toKey: string,
): BrainEdge | undefined {
  const from = findNode(g, fromKey);
  const to = findNode(g, toKey);
  if (!from || !to || from.id === to.id) return undefined;
  const now = Date.now();
  const id = edgeId(from.id, relation, to.id);
  let e = g.edges.find((x) => x.id === id);
  if (e) {
    e.updatedAt = now;
    return e;
  }
  e = { id, from: from.id, to: to.id, relation: relation.trim(), weight: 1, hits: 0, createdAt: now, updatedAt: now };
  g.edges.push(e);
  return e;
}

// 命中强化：被 recall 命中的节点/边 weight+hits 增长，越用越浮现（赫布式）。
export function reinforce(g: BrainGraph, nodeIds: string[], edgeIds: string[] = []): void {
  const now = Date.now();
  const ns = new Set(nodeIds);
  const es = new Set(edgeIds);
  for (const n of g.nodes)
    if (ns.has(n.id)) {
      n.hits += 1;
      n.weight += 1;
      n.lastHit = now;
    }
  for (const e of g.edges)
    if (es.has(e.id)) {
      e.hits += 1;
      e.weight += 1;
    }
}

// 删节点（连带删除其所有边）
export function removeNode(g: BrainGraph, key: string): boolean {
  const node = findNode(g, key);
  if (!node) return false;
  g.nodes = g.nodes.filter((n) => n.id !== node.id);
  g.edges = g.edges.filter((e) => e.from !== node.id && e.to !== node.id);
  return true;
}

export function removeEdge(g: BrainGraph, id: string): boolean {
  const before = g.edges.length;
  g.edges = g.edges.filter((e) => e.id !== id);
  return g.edges.length < before;
}
