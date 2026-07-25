// 文档冷存储层：把知识宫殿等大文本目录分块 + 本地向量化，存 ~/.minicc/brain/docs.json。
// 概念网络（graph）负责"高价值概念点"的热索引；本层负责"需要细节时按需路由过去读的原文"。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { BrainDoc, BrainDocIndex } from "./types.js";
import { EMPTY_DOC_INDEX } from "./types.js";
import { BRAIN_DIR } from "./store.js";
import { embed, cosine } from "./embed.js";

export const DOCS_FILE = join(BRAIN_DIR, "docs.json");

const MAX_CHARS = 1100; // 单块目标上限：太长稀释语义、太短割裂上下文
const MIN_CHARS = 60; // 太短的碎块（单标题行等）并入相邻，不单独成块

export function loadDocIndex(): BrainDocIndex {
  try {
    const d = JSON.parse(readFileSync(DOCS_FILE, "utf8"));
    if (!d || !Array.isArray(d.chunks)) return { ...EMPTY_DOC_INDEX };
    return d as BrainDocIndex;
  } catch {
    return { ...EMPTY_DOC_INDEX };
  }
}

export function saveDocIndex(idx: BrainDocIndex): void {
  mkdirSync(BRAIN_DIR, { recursive: true });
  writeFileSync(DOCS_FILE, JSON.stringify(idx), "utf8");
}

// 递归收集目录下的 .md 文件（跳过隐藏目录/备份）
function collectMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (extname(e.name).toLowerCase() === ".md" && !/_bak(_|\.)/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// 把一个 markdown 文件按标题层级分块，块内超长按段落/字数硬切；保留标题面包屑
export function chunkMarkdown(raw: string, relPath: string): BrainDoc[] {
  const lines = raw.split("\n");
  const stack: { level: number; text: string }[] = []; // 标题栈，构造面包屑
  const chunks: BrainDoc[] = [];
  let buf: string[] = [];
  let curTitle = "";
  let curPath = "";

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length < MIN_CHARS && !chunks.length) return; // 开头零碎丢弃
    if (text.length < MIN_CHARS && chunks.length) {
      // 太短并入上一块（避免碎片）
      chunks[chunks.length - 1].text += "\n" + text;
      return;
    }
    // 超长按段落/字数硬切
    for (const piece of splitLong(text, MAX_CHARS)) {
      chunks.push({
        id: `${relPath}#${chunks.length}`,
        file: relPath,
        title: curTitle,
        headingPath: curPath,
        text: piece,
      });
    }
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush(); // 新标题前先收束当前块
      const level = m[1].length;
      const text = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      curTitle = text;
      curPath = stack.map((s) => s.text).join(" › ");
      buf.push(line);
    } else {
      buf.push(line);
      if (buf.join("\n").length >= MAX_CHARS) flush();
    }
  }
  flush();
  return chunks;
}

// 超长文本按空行段落聚合到 ~max 一块；单段仍超长则按字数硬切
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur + "\n\n" + p).length > max) {
      out.push(cur);
      cur = "";
    }
    if (p.length > max) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface BuildProgress {
  phase: "scan" | "embed" | "done";
  files?: number;
  total?: number;
  done?: number;
}

// 构建/重建索引：扫描目录 → 分块 → 批量本地向量化 → 落盘。onProgress 汇报进度。
export async function buildDocIndex(
  dir: string,
  onProgress?: (p: BuildProgress) => void,
): Promise<BrainDocIndex> {
  const files = collectMarkdown(dir);
  onProgress?.({ phase: "scan", files: files.length });
  const chunks: BrainDoc[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf8");
      chunks.push(...chunkMarkdown(raw, relative(dir, f)));
    } catch {
      /* 跳过读不了的文件 */
    }
  }
  // 批量向量化（分批，避免一次喂太多）
  const BATCH = 64;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await embed(
      batch.map((c) => (c.headingPath ? c.headingPath + "\n" + c.text : c.text)),
      "passage",
    );
    if (vecs) batch.forEach((c, j) => (c.embedding = vecs[j]));
    onProgress?.({ phase: "embed", total: chunks.length, done: Math.min(i + BATCH, chunks.length) });
  }
  const idx: BrainDocIndex = { version: 1, dir, builtAt: Date.now(), chunks };
  saveDocIndex(idx);
  onProgress?.({ phase: "done", total: chunks.length, done: chunks.length });
  return idx;
}

export interface DocHit {
  id: string;
  file: string;
  headingPath: string;
  snippet: string;
  score: number;
}

// 语义检索文档块（需要 query 向量；无向量时退化为关键词包含）
export async function searchDocs(query: string, limit = 4, preVec?: number[]): Promise<DocHit[]> {
  const idx = loadDocIndex();
  if (!idx.chunks.length) return [];
  const qv = preVec ? [preVec] : await embed([query], "query");
  let scored: { c: BrainDoc; score: number }[];
  if (qv) {
    scored = idx.chunks
      .filter((c) => c.embedding?.length)
      .map((c) => ({ c, score: cosine(qv[0], c.embedding!) }));
    scored.sort((a, b) => b.score - a.score);
    scored = scored.filter((s) => s.score >= 0.82).slice(0, limit); // 文档块绝对门槛，避免弱相关刷屏
  } else {
    const q = query.toLowerCase();
    scored = idx.chunks
      .filter((c) => c.text.toLowerCase().includes(q) || c.headingPath.toLowerCase().includes(q))
      .slice(0, limit)
      .map((c) => ({ c, score: 0 }));
  }
  return scored.map(({ c, score }) => ({
    id: c.id,
    file: c.file,
    headingPath: c.headingPath,
    snippet: c.text.length > 220 ? c.text.slice(0, 220) + "…" : c.text,
    score,
  }));
}

// 读原文：按 chunkId 或文件相对路径，返回整块/整文件（供 brain_read_doc 按需路由）
export function readDoc(idOrFile: string): string {
  const idx = loadDocIndex();
  if (!idx.dir) return "(尚未建立文档索引)";
  // 优先当 chunkId
  const chunk = idx.chunks.find((c) => c.id === idOrFile);
  if (chunk) {
    // 返回同文件全文更有用（一块往往不够）
    const full = readFullFile(idx.dir, chunk.file);
    return full ?? chunk.text;
  }
  // 当文件路径
  const byFile = readFullFile(idx.dir, idOrFile);
  if (byFile != null) return byFile;
  return `(未找到：${idOrFile})`;
}

function readFullFile(dir: string, relPath: string): string | null {
  try {
    const full = join(dir, relPath);
    // 防目录穿越：必须在 dir 内
    if (!full.startsWith(dir)) return null;
    statSync(full);
    const raw = readFileSync(full, "utf8");
    const MAX = 16000;
    return raw.length > MAX ? raw.slice(0, MAX) + `\n…(已截断，全文 ${raw.length} 字符，路径 ${relPath})` : raw;
  } catch {
    return null;
  }
}

export function docStats(): { chunks: number; files: number; dir: string; builtAt: number } {
  const idx = loadDocIndex();
  const files = new Set(idx.chunks.map((c) => c.file));
  return { chunks: idx.chunks.length, files: files.size, dir: idx.dir, builtAt: idx.builtAt };
}
