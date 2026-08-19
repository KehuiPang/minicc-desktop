// Agent 主循环：Claude Code 的心脏。
//   组装消息 → 请求模型 → 若要调工具则执行并回灌 → 循环 → 直到模型给最终文字。
// P2：累计 token 用量 + 上下文过长时自动压缩（把旧历史总结成一段，保留最近若干条）。
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResult,
  Tool,
  ToolContext,
} from "../types.js";
import { collapseRepeatedText } from "./repetition.js";

// —— 上下文 token 粗估(发请求前判断该不该压缩;真实分词拿不到,宁可略高以尽早压缩) ——
// 中文/日韩表意字 ≈0.6 token/字，其它(英文/代码/符号) ≈0.28 token/字。
function estimateText(s: string): number {
  if (!s) return 0;
  const cjk = (s.match(/[　-鿿豈-﫿＀-￯]/g) || []).length;
  return cjk * 0.6 + (s.length - cjk) * 0.28;
}
function estimateBlockTokens(b: ContentBlock): number {
  if (b.type === "text") return estimateText(b.text);
  if (b.type === "tool_use") return estimateText(b.name) + estimateText(JSON.stringify(b.input || {}));
  if (b.type === "tool_result") return estimateText(String(b.content ?? ""));
  if (b.type === "image") return 1500; // 图片按常见上限估(实际按尺寸,取偏高值防漏压)
  return 0;
}
function estimateMsgTokens(m: Message): number {
  let n = 4; // 每条消息的角色/包裹开销
  for (const b of m.content || []) n += estimateBlockTokens(b);
  return n;
}

// 识别"上下文撞上限"类错误(prompt too long / context length / 413)，与普通 400 区分开
function isPromptTooLong(e: unknown): boolean {
  const err = e as { status?: number; message?: string; error?: { message?: string } };
  const msg = `${err?.message || ""} ${err?.error?.message || ""}`.toLowerCase();
  return (
    err?.status === 413 ||
    /prompt is too long|too many tokens|context (length|window)|maximum.*token|exceed.*context/.test(msg)
  );
}

export type PermissionDecision = "allow" | "deny";

export interface AgentOptions {
  compactThreshold?: number; // 上一轮 input tokens 超过此值触发压缩（0=关闭）
  keepRecent?: number; // 压缩时保留最近多少条原始消息
}

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  lastInput: number; // 最近一次请求的输入 token，≈当前上下文大小
  totalCacheHit: number; // 累计缓存命中输入 token（算钱用）
  totalCacheMiss: number; // 累计缓存未命中输入 token
  totalSteps: number; // 累计模型请求次数（多步工具时每步一次；用于算"本轮步数"）
}

// 本轮(一次 send)自足的用量：每轮从 0 起累加，直接盖在助手消息上，
// 不靠跨轮累计做差 → 不受历史/跨版本污染，缓存命中与真正新增各自独立、单价能分开算。
export interface RoundUsage {
  input: number; // 本轮总输入(每步重发上下文累加)
  output: number; // 本轮总输出
  cacheHit: number; // 本轮缓存命中的输入 token（便宜）
  cacheMiss: number; // 本轮真正新增的输入 token（贵）
  steps: number; // 本轮模型请求次数
  lastInput: number; // 本轮最后一次请求的输入量(≈当前上下文)
}
// onUsage 上报的用量 = 会话累计 + 本轮自足值
export type UsageReport = SessionUsage & { round?: RoundUsage };

export interface AgentHooks {
  onText?(delta: string): void;
  onReasoning?(delta: string): void; // 思考过程流式(模型正式回答前的推理)
  requestPermission?(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision>;
  onToolStart?(id: string, name: string, input: Record<string, unknown>): void;
  onToolEnd?(id: string, result: string, isError: boolean): void;
  onAssistantDone?(): void;
  onUsage?(u: UsageReport): void; // 每步回报累计用量 + 本轮自足值
  onRateLimits?(rl: import("../types.js").RateLimits): void; // 订阅额度快照
  onCompact?(before: number, after: number): void; // 压缩发生时回报条数变化
  onStep?(): void; // 每完成一段(助手消息/工具结果)后回调：用于即时落盘，重启不丢进度
  onRecover?(cleanedText: string): void; // 模型把工具调用当文本吐出→兜底解析后，回传清理后的正文供前端修正显示
}

// 去掉落单的杂字文本块(模型偶发把杂词/单字跟正文或工具调用一起吐出，如 "count"/"course"/"课")。
// 铁律：仅当本轮还有其它内容块时才清——绝不删「唯一的那条正文」(短回复如"好的""对"原样保留)。
// 只删「落单的噪音块」：纯 1-15 个英文字母、或纯 1-3 个汉字、或纯 1-4 个标点/符号，且不含空格/换行(带空格=正常正文)。
function stripStrayText(content: ContentBlock[]): ContentBlock[] {
  if (content.length <= 1) return content; // 只有一块=真正的回答，绝不动
  const isNoise = (raw: string): boolean => {
    const t = raw.trim();
    if (!t || /\s/.test(t)) return false; // 空/含空格换行=正常正文，放过
    return (
      /^[A-Za-z]{1,15}$/.test(t) || // 落单短英文(count/course…)
      /^[一-龥]{1,3}$/.test(t) || // 落单 1-3 个汉字(课…)
      /^[\p{P}\p{S}]{1,4}$/u.test(t) // 落单标点/符号
    );
  };
  const kept = content.filter((b) => !(b.type === "text" && isNoise((b as any).text || "")));
  if (kept.length === content.length) return content; // 没删任何东西，原样返回(保持引用不变)
  return kept.length ? kept : content; // 万一全被判噪音，宁可不动也不返回空
}

// 折叠退化重复：某文本块若被模型刷成「短单元无限重复」(如整块 count\ncount…)，
// 折叠成几遍+提示。与流式守卫(provider 里已提前中止)互补——这里兜底清理已落地的重复块，
// 让屏上(经 onRecover)和历史都干净，下一轮模型不会顺着旧输出继续刷。
// 有块被折叠→返回新数组(触发上层替换/前端刷新)；无则原样返回，保持引用不变。
function collapseRepeatedBlocks(content: ContentBlock[]): ContentBlock[] {
  let changed = false;
  const out = content.map((b) => {
    if (b.type !== "text") return b;
    const collapsed = collapseRepeatedText((b as any).text || "");
    if (collapsed == null) return b;
    changed = true;
    return { type: "text", text: collapsed } as ContentBlock;
  });
  return changed ? out : content;
}

// —— 学习式「漏字前缀」清除 ——
// 模型偶发在正文最前面粘一个与内容无关的杂词(如 count)，紧贴中文、几乎每条都冒出来
// (常是早前 count\ncount 重复循环污染了历史所致)。这类整块粘连 stripStrayText 抓不到。
// 策略：某个「小写英文词紧贴中文」的开头词，在本会话作为开头反复出现(≥THRESH 次)→判为杂词，
// 之后(含当前及历史)一律从开头剥掉。只认小写且不在命令词白名单里的词——正经缩写(GWT/IM1)、
// 命令(git/npm)、带连字符词(f-string检查)都不会命中，极少误伤。
const STRAY_LEAD_THRESH = 3;
// 开头：2-15 个小写字母，后面紧跟 空白/中文/结尾(即它单独成词，不是某个更长英文词的一截)。
// 命中则捕获那个词。含空白→能抓「card 读文档…」「card\n读文档…」乃至整块就一个「card」。
const STRAY_LEAD_RE = /^([a-z]{2,15})(?=[\s一-鿿]|$)/;
// 已知的模型退化杂词：反复出现、明确无意义(常由 count\ncount 重复循环污染历史所致)。
// 预置为「已知杂词」→ 第一次粘在正文开头就剥，不必等攒够 STRAY_LEAD_THRESH 次才学会，
// 免得开头几条仍漏出「course 提。」这种。都是小写英文、紧贴中文时几乎不可能是正经内容。
const STRAY_LEAD_SEED = ["count", "course", "card"];
// 常见合法的小写命令/工具词，绝不当杂词剥
const STRAY_LEAD_ALLOW = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "ssh", "scp", "cd", "ls", "rm", "cp", "mv", "cat",
  "sudo", "python", "node", "deno", "bun", "docker", "kubectl", "curl", "wget", "vim",
  "nvim", "brew", "pip", "go", "cargo", "make", "bash", "sh", "zsh", "grep", "sed", "awk",
  "tar", "ffmpeg", "mysql", "redis", "nginx", "conda", "adb", "gcc", "clang", "java",
]);
// 取一条消息里首个非空文本块的开头小写词(紧贴中文)；无则 null
function leadStrayWord(content: ContentBlock[]): string | null {
  const tb = content.find((b) => b.type === "text" && ((b as any).text || "").length);
  if (!tb) return null;
  const m = ((tb as any).text as string).match(STRAY_LEAD_RE);
  if (!m) return null;
  const w = m[1];
  return STRAY_LEAD_ALLOW.has(w) ? null : w;
}

// 兜底：模型偶尔把工具调用写成文本(<invoke name="x"><parameter name="y">…</parameter></invoke>)，
// 导致没有结构化 tool_use → 循环判定"结束"而自动停止，且屏上留一堆 XML 符号。
// 这里把这种泄漏的调用解析回来，转成真正的 tool_use 去执行，并给出去掉 XML 的干净正文。
function recoverLeakedToolCalls(
  content: ContentBlock[],
): { toolUses: Extract<ContentBlock, { type: "tool_use" }>[]; newContent: ContentBlock[] } | null {
  const text = content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  if (!/<(?:antml:)?invoke\s+name=/.test(text)) return null;
  const invokeRe = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
  const toolUses: any[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = invokeRe.exec(text))) {
    const name = m[1];
    const inner = m[2];
    const input: Record<string, unknown> = {};
    const paramRe = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(inner))) {
      const key = p[1];
      const t = String(p[2]).trim();
      let val: unknown = p[2];
      if (/^-?\d+(\.\d+)?$/.test(t)) val = Number(t);
      else if (t === "true" || t === "false") val = t === "true";
      else if (/^[[{]/.test(t)) {
        try {
          val = JSON.parse(t);
        } catch {
          /* 保留原字符串 */
        }
      }
      input[key] = val;
    }
    toolUses.push({ type: "tool_use", id: `leak_${Date.now()}_${i++}`, name, input });
  }
  if (!toolUses.length) return null;
  const cleanedText = text
    .replace(/<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/g, "")
    .replace(/<(?:antml:)?invoke\s+name="[^"]+"\s*>[\s\S]*?<\/(?:antml:)?invoke>/g, "")
    .trim();
  const newContent: ContentBlock[] = [];
  if (cleanedText) newContent.push({ type: "text", text: cleanedText } as ContentBlock);
  newContent.push(...(toolUses as ContentBlock[]));
  return { toolUses: toolUses as any, newContent };
}

export class Agent {
  private messages: Message[] = [];
  private usage: SessionUsage = {
    totalInput: 0,
    totalOutput: 0,
    lastInput: 0,
    totalCacheHit: 0,
    totalCacheMiss: 0,
    totalSteps: 0,
  };
  private compactThreshold: number;
  private keepRecent: number;
  private pendingInject: { text: string; images: string[] }[] = []; // 运行中注入的新需求，循环边界取用
  private round: RoundUsage = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, steps: 0, lastInput: 0 }; // 本轮自足用量
  private softStop = false; // 温和停止:不切断当前输出，让本轮自然吐完并干净落历史后，在下个边界停
  private leadStrayCount = new Map<string, number>(); // 「漏字前缀」候选词→作为开头出现的次数
  private knownStray = new Set<string>(STRAY_LEAD_SEED); // 已判定的杂词前缀，见即剥(预置已知退化词)

  constructor(
    private provider: Provider,
    private system: string,
    private tools: Tool[],
    private ctx: ToolContext,
    private toolMap: Map<string, Tool>,
    opts: AgentOptions = {},
  ) {
    this.compactThreshold = opts.compactThreshold ?? 60000;
    this.keepRecent = opts.keepRecent ?? 6;
  }

  // 温和停止:不 abort 当前模型流，让它把这轮自然吐完、完整落历史后，在下个循环边界干净停下。
  // 与 abort(硬中断)分开:硬中断会截断输出、留悬空 tool_use 需事后补 (已停止) 补丁；软停止不会。
  requestSoftStop() {
    this.softStop = true;
  }
  isSoftStopping(): boolean {
    return this.softStop;
  }

  // 收尾:把当前(已完整生成的)助手消息里想调的工具剥掉，只保留已写完的正文，
  // 让历史干净停在一条「完整的助手消息」上——不切断、不留截断疤，下次发消息无缝接续。
  private finishSoftStop(hooks: AgentHooks): void {
    this.pendingInject = []; // 停止即停干净:丢掉还没并入的注入消息，避免下一轮乱序冒出来
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      const kept = last.content.filter((b) => b.type !== "tool_use");
      const hadToolUse = kept.length !== last.content.length;
      const hasText = kept.some((b) => b.type === "text" && ((b as any).text || "").trim());
      this.messages[this.messages.length - 1] = {
        role: "assistant",
        content: hasText ? kept : [{ type: "text", text: "（已停止）" }], // 极少数「纯工具无正文」才占位，但这是完整边界非截断
        ts: last.ts,
        usage: last.usage,
      };
      // 刚剥掉半截工具调用 → 通知前端把它从屏上抹掉，只留正文
      if (hadToolUse) {
        const t = (hasText ? kept : [])
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        hooks.onRecover?.(t);
      }
    }
    hooks.onStep?.();
    hooks.onAssistantDone?.();
  }

  // 运行中注入新需求：不打断当前步，在下一个循环边界并入历史，让模型综合权衡/优先处理
  injectUser(text: string, images: string[] = []) {
    if ((text && text.trim()) || images.length) this.pendingInject.push({ text, images });
  }
  private drainInject(): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const p of this.pendingInject) {
      if (p.text && p.text.trim()) blocks.push({ type: "text", text: p.text });
      for (const im of p.images) blocks.push({ type: "image", dataUrl: im });
    }
    this.pendingInject = [];
    return blocks;
  }
  hasPendingInject(): boolean {
    return this.pendingInject.length > 0;
  }
  // 撤回一条尚未处理的注入消息(还在缓冲里)：命中返回 true，AI 从未看到它
  recallPendingInject(text: string): boolean {
    const i = this.pendingInject.findIndex((p) => p.text === text);
    if (i >= 0) {
      this.pendingInject.splice(i, 1);
      return true;
    }
    return false;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  // 供 UI 显示用：正式历史 + 尚未并入历史的注入消息(还在 pendingInject 缓冲里)。
  // 修复「运行中发的消息切走再切回就不见了」——切回时用正式历史整体重建，pending 注入还没 drain 进历史故被抹掉。
  // 只影响显示，不动 getMessages()(模型历史/标题/建议仍用它)。drain 后 pendingInject 清空，下次重建走正式历史，不重复。
  getDisplayMessages(): Message[] {
    if (this.pendingInject.length === 0) return this.messages;
    const pend: Message[] = this.pendingInject
      .filter((p) => (p.text && p.text.trim()) || p.images.length)
      .map((p) => ({
        role: "user" as const,
        content: [
          ...(p.text && p.text.trim() ? [{ type: "text", text: p.text } as ContentBlock] : []),
          ...p.images.map((im) => ({ type: "image", dataUrl: im }) as ContentBlock),
        ],
        ts: Date.now(),
      }));
    return [...this.messages, ...pend];
  }

  // 载入已保存的会话历史（切换/恢复会话时用）
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
    this.learnStrayFromHistory(); // 载入即扫历史学出杂词前缀并清掉，让下一条回复就干净
  }

  // 扫历史里各助手消息的开头小写词(紧贴中文)，统计领头次数；达阈值者判为杂词并从历史里剥掉。
  // 解决「早前被污染的会话一打开，模型顺着旧输出继续冒 count」——先给它一个干净上下文。
  private learnStrayFromHistory(): void {
    this.leadStrayCount.clear();
    // 预置的已知退化词(count/course/card)：加载即从历史里追溯剥掉，别让旧污染会话开头几条还脏
    for (const w of this.knownStray) this.sweepStrayLead(w);
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      const w = leadStrayWord(m.content);
      if (w) this.leadStrayCount.set(w, (this.leadStrayCount.get(w) || 0) + 1);
    }
    for (const [w, c] of this.leadStrayCount) {
      if (c >= STRAY_LEAD_THRESH) {
        this.knownStray.add(w);
        this.sweepStrayLead(w);
      }
    }
  }

  // 从历史里所有「该词领头」的助手消息剥掉这个杂词前缀(就地改，给模型干净上下文)。
  // 词后带的空白一并去掉；若整块就是这个词→有其它块(工具调用等)则删掉该空块，否则留着不造空消息。
  private sweepStrayLead(word: string): void {
    const re = new RegExp("^" + word + "(?=[\\s一-鿿]|$)");
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      for (let i = 0; i < m.content.length; i++) {
        const b = m.content[i];
        if (b.type !== "text" || !re.test((b as any).text || "")) continue;
        const stripped = ((b as any).text as string).slice(word.length).replace(/^[ \t\r\n]+/, "");
        if (stripped) (b as any).text = stripped;
        else if (m.content.length > 1) {
          m.content.splice(i, 1);
          i--;
        }
      }
    }
  }

  // 处理单条助手消息的开头杂词：已知杂词→直接剥；未知→计数，达阈值则登记为杂词、清历史、剥当前。
  // 返回可能被剥过的新内容(引用变了→上层触发替换+onRecover 修正屏显)。
  private stripLearnedStrayLead(content: ContentBlock[]): ContentBlock[] {
    const w = leadStrayWord(content);
    if (!w) return content;
    let strip = this.knownStray.has(w);
    if (!strip) {
      const c = (this.leadStrayCount.get(w) || 0) + 1;
      this.leadStrayCount.set(w, c);
      if (c >= STRAY_LEAD_THRESH) {
        this.knownStray.add(w);
        this.sweepStrayLead(w); // 追溯清掉历史里已积累的同款杂词
        strip = true;
      }
    }
    if (!strip) return content;
    const idx = content.findIndex((b) => b.type === "text" && ((b as any).text || "").length);
    if (idx < 0) return content;
    const stripped = ((content[idx] as any).text as string).slice(w.length).replace(/^[ \t\r\n]+/, "");
    const nc = content.slice();
    if (stripped) {
      nc[idx] = { type: "text", text: stripped } as ContentBlock;
    } else {
      // 整块就是这个杂词：有其它块(工具调用等)则删掉这个空块；只有这一块则留着，别造空消息
      const hasOther = content.some(
        (b, i) => i !== idx && !(b.type === "text" && !((b as any).text || "").trim()),
      );
      if (!hasOther) return content;
      nc.splice(idx, 1);
    }
    return nc;
  }

  // 运行时切换模型后端（用户在设置里改 provider/model）
  setProvider(p: Provider): void {
    this.provider = p;
  }

  setSystem(s: string): void {
    this.system = s;
  }

  // 运行时更新工具集（如 MCP 服务器连接后动态加入其工具）
  setTools(tools: Tool[], toolMap: Map<string, Tool>): void {
    this.tools = tools;
    this.toolMap = toolMap;
  }

  // 运行时调整压缩参数(设置里改"保留最近N条"/阈值时热更)
  setCompactOpts(opts: { compactThreshold?: number; keepRecent?: number }): void {
    if (typeof opts.compactThreshold === "number") this.compactThreshold = opts.compactThreshold;
    if (typeof opts.keepRecent === "number" && opts.keepRecent > 0) this.keepRecent = opts.keepRecent;
  }

  getUsage(): SessionUsage {
    return this.usage;
  }

  setUsage(u: SessionUsage): void {
    // 兼容旧会话存档（无缓存明细字段）
    this.usage = {
      ...u,
      totalCacheHit: u.totalCacheHit ?? 0,
      totalCacheMiss: u.totalCacheMiss ?? 0,
      totalSteps: u.totalSteps ?? 0,
    };
  }

  async send(
    userInput: string,
    hooks: AgentHooks,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<void> {
    const userContent: ContentBlock[] = [];
    if (userInput) userContent.push({ type: "text", text: userInput });
    for (const dataUrl of images ?? []) userContent.push({ type: "image", dataUrl });
    if (userContent.length === 0) return;
    this.ensureCanAcceptUser(); // 上一轮若被中断,先修好历史尾部,避免连续user/悬空tool_use致API 400
    this.messages.push({ role: "user", content: userContent, ts: Date.now() });
    this.round = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, steps: 0, lastInput: 0 }; // 本轮清零重记
    this.softStop = false; // 新一轮开始，清掉上一轮可能残留的软停止标志
    let shrinkAttempts = 0; // 撞上下文上限后的紧急压缩重试计数(防死循环)

    while (true) {
      if (signal?.aborted) return; // 已被用户硬中断(abort)
      // 温和停止:上一步(工具结果/助手)已干净入历史。若尾部是 user(tool_result)，补一条完整助手收尾，
      // 让历史停在助手消息上(完整边界，非截断)，下次发消息无缝接续，且不再触发新的模型请求。
      if (this.softStop) {
        this.pendingInject = []; // 停止即停干净:丢掉还没并入的注入消息
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "user") {
          this.messages.push({ role: "assistant", content: [{ type: "text", text: "（已停止）" }], ts: Date.now() });
          hooks.onStep?.();
        }
        hooks.onAssistantDone?.();
        return;
      }
      // 上下文过长则先压缩，再请求模型（省 token / 防撑爆）
      await this.maybeCompact(hooks);

      let result: ProviderResult;
      try {
        result = await this.provider.complete(this.system, this.messages, this.tools, {
          onText: hooks.onText,
          onReasoning: hooks.onReasoning,
          signal,
        });
      } catch (e) {
        // 撞上下文上限(prompt too long)→ 不把死错抛给用户:强制压缩后重试本轮。
        // 根因:压缩阈值只看"上一轮成功的 input tokens",请求失败不返回 usage→它冻住→
        // 自动压缩永远触发不了→每轮必挂。这里兜底强制瘦身再重发,打破死锁。
        if (isPromptTooLong(e) && shrinkAttempts < 5 && (await this.emergencyShrink(hooks))) {
          shrinkAttempts++;
          continue;
        }
        throw e;
      }
      shrinkAttempts = 0; // 成功一次即重置,之后再撞再压

      this.usage.totalSteps += 1; // 每次模型请求算一步(不管有没有返回 usage)
      this.round.steps += 1;
      if (result.usage) {
        const inTok = result.usage.inputTokens;
        const hit = result.usage.cacheHitTokens ?? 0;
        const miss = result.usage.cacheMissTokens ?? Math.max(0, inTok - hit);
        // 累计(给"当前上下文"/费用总览/持久化恢复)
        this.usage.totalInput += inTok;
        this.usage.totalOutput += result.usage.outputTokens;
        this.usage.lastInput = inTok;
        this.usage.totalCacheHit += hit;
        this.usage.totalCacheMiss += miss;
        // 本轮自足(每步各自独立累加,缓存命中/新增互不串)
        this.round.input += inTok;
        this.round.output += result.usage.outputTokens;
        this.round.cacheHit += hit;
        this.round.cacheMiss += miss;
        this.round.lastInput = inTok;
      }
      const snap: UsageReport = { ...this.usage, round: { ...this.round } };
      hooks.onUsage?.(snap); // 每步都上报(即使无 usage 也让步数实时刷新)
      if (result.rateLimits) hooks.onRateLimits?.(result.rateLimits);

      // 盖上用量快照(累计 + 本轮自足值)：UI 直接读本轮值,不靠跨轮做差;并存进历史供重开后仍可看
      this.messages.push({
        role: "assistant",
        content: result.content,
        ts: Date.now(),
        usage: {
          totalInput: this.usage.totalInput,
          totalOutput: this.usage.totalOutput,
          lastInput: this.usage.lastInput,
          totalCacheHit: this.usage.totalCacheHit,
          totalCacheMiss: this.usage.totalCacheMiss,
          totalSteps: this.usage.totalSteps,
          round: { ...this.round },
        },
      });
      hooks.onStep?.(); // 助手段落已入历史，即时落盘(重启不丢)

      let toolUses = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      let finalContent: ContentBlock[] = result.content;

      // 兜底1：没有结构化 tool_use 时，看是否把工具调用当文本写出来了(<invoke …>)，是则解析回来执行、继续跑
      if (toolUses.length === 0) {
        const recovered = recoverLeakedToolCalls(result.content);
        if (recovered) {
          toolUses = recovered.toolUses;
          finalContent = recovered.newContent;
        }
      }
      // 兜底2：去掉像 "count"/"课" 这种落单杂字块——不再要求必须有工具调用，纯文字轮也清；
      // 中/英/符号一起认。防止杂字漏进历史被下一轮模型学去、越滚越乱。
      finalContent = stripStrayText(finalContent);
      // 兜底3：某文本块被刷成退化重复(count\ncount…)→折叠成几遍+提示，别污染历史/下一轮
      finalContent = collapseRepeatedBlocks(finalContent);
      // 兜底4：正文开头粘的杂词前缀(如每条都冒 count紧贴中文)→学习后剥掉，别污染历史/下一轮
      finalContent = this.stripLearnedStrayLead(finalContent);

      // 内容被清理过 → 替换历史里那条 + 通知前端修正屏上显示
      if (finalContent !== result.content) {
        this.messages[this.messages.length - 1] = {
          role: "assistant",
          content: finalContent,
          ts: Date.now(),
        };
        const t = finalContent
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        hooks.onRecover?.(t);
      }

      // 温和停止检查点:此刻这轮模型已「完整」生成并入历史(不是被截断的半截)。
      // 剥掉它接下来想调的工具、保留已写完的正文，干净停在一条完整助手消息上就返回——
      // 既让 AI 把话说完，又不再执行新动作/发新请求，历史尾部合法，下次无缝接续。
      if (this.softStop) {
        this.finishSoftStop(hooks);
        return;
      }

      if (toolUses.length === 0) {
        // 助手已给出无工具的回复：若期间用户注入了新需求，接着处理它(不结束本回合)
        const inj = this.drainInject();
        if (inj.length) {
          this.messages.push({ role: "user", content: inj, ts: Date.now() });
          continue;
        }
        hooks.onAssistantDone?.();
        return;
      }

      // 结果按原顺序回填(并行也不乱序)；只读工具并行跑，写类工具串行(防写竞态/保权限提示有序)
      const resultsBlocks: ContentBlock[] = new Array(toolUses.length);
      const parallelJobs: Promise<void>[] = [];
      for (let idx = 0; idx < toolUses.length; idx++) {
        const call = toolUses[idx];
        const tool = this.toolMap.get(call.name);
        if (!tool) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: `未知工具: ${call.name}`,
            is_error: true,
          };
          continue;
        }
        // 已中断：不再启动新工具，直接填占位结果(仍保证每个 tool_use 都有配对 tool_result)
        if (signal?.aborted) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: "(已停止)",
            is_error: true,
          };
          continue;
        }

        if (!tool.readOnly && hooks.requestPermission) {
          const decision = await hooks.requestPermission(tool, call.input);
          if (decision === "deny") {
            resultsBlocks[idx] = {
              type: "tool_result",
              tool_use_id: call.id,
              content: "用户拒绝了该操作。",
              is_error: true,
            };
            continue;
          }
        }

        const job = (async () => {
          hooks.onToolStart?.(call.id, call.name, call.input);
          const out = await tool.run(call.input, { ...this.ctx, signal }); // 传中断信号,停止时杀长命令
          hooks.onToolEnd?.(call.id, out.content, !!out.isError);
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: out.content,
            is_error: out.isError,
          };
        })();
        if (tool.readOnly) parallelJobs.push(job); // 只读：并行
        else await job; // 写类：等它跑完再继续下一个，串行执行
      }
      await Promise.all(parallelJobs); // 等所有并行只读工具收齐
      // 兜底：任何漏填的位补上占位结果，确保 tool_use↔tool_result 一一配对(否则下次请求 400)
      for (let idx = 0; idx < toolUses.length; idx++) {
        if (!resultsBlocks[idx]) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: toolUses[idx].id,
            content: "(已停止)",
            is_error: true,
          };
        }
      }

      // 运行中注入的新需求：并入本条 user 消息(tool_result + 文本/图片)，下一步模型即可看到并综合安排
      const inj = this.drainInject();
      if (inj.length) resultsBlocks.push(...inj);
      this.messages.push({ role: "user", content: resultsBlocks });
      hooks.onStep?.(); // 工具结果已入历史，即时落盘
      if (signal?.aborted) return; // 中断：tool_result 已入队(历史合法)，就此结束
    }
  }

  // 生成「工作交接文档」：把本会话历史里真正有价值的内容(目标/决策/涉及的文件命令参数机器/
  // 已完成/当前进展/未完成/下一步/坑)提炼成一份结构化中文文档，明确剔除跑题与噪音。
  // 用途：老对话上下文被污染/太长时，一键交接到一个干净的新对话接着做。用本会话自己的模型来总结。
  async makeHandoff(): Promise<string> {
    const msgs = [...this.messages]; // 快照:即使源会话还在跑，也按当下这份历史来总结，不受后续 mutate 影响
    let transcript = msgs
      .map((m) => {
        const parts = (m.content || [])
          .map((b: any) => {
            if (b.type === "text") return b.text;
            if (b.type === "tool_use") return `[调用 ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`;
            if (b.type === "tool_result") return `[结果: ${String(b.content).slice(0, 500)}]`;
            if (b.type === "image") return "[图片]";
            return "";
          })
          .filter(Boolean)
          .join("\n");
        return parts ? `${m.role === "user" ? "用户" : "助手"}：${parts}` : "";
      })
      .filter((s) => s.length > 3)
      .join("\n\n");
    if (!transcript.trim()) return "";
    // 太长则掐头留尾(目标通常在开头、最新进展在结尾)，防喂给模型时超上下文
    const MAX = 80000;
    if (transcript.length > MAX) {
      transcript = transcript.slice(0, 6000) + "\n\n…(中间大段略去)…\n\n" + transcript.slice(-(MAX - 6000));
    }
    // 掐头留尾的切点可能落在 UTF-16 代理对(emoji/部分字符)中间，留下孤立代理，
    // JSON.stringify 会产出非法 JSON 致 API 400(no low/high surrogate)。清掉落单的代理字符。
    transcript = transcript.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    const res = await this.provider.complete(
      "你是「工作交接文档」整理器。下面是一段可能很长、甚至跑题或被无关内容污染的工作对话。" +
        "请只抽取真正有价值的信息，产出一份结构清晰的中文交接文档，让接手者(另一个 AI 助手)不看原对话也能直接继续干活。" +
        "务必分节输出：\n" +
        "1) 目标/任务：用户到底要做什么；\n" +
        "2) 关键背景与决策：涉及的项目/仓库/机器/服务/文件路径/命令/参数/配置，已敲定的方案及理由；\n" +
        "3) 已完成：具体做了什么、改了哪些文件、验证结果；\n" +
        "4) 当前进展 / 未完成：正卡在哪、还差什么；\n" +
        "5) 下一步：接手者应立刻执行的具体动作(有序列出)；\n" +
        "6) 坑与注意事项：踩过的坑、红线、易错点。\n" +
        "要求：条目式、带具体名字(别泛泛而谈)、剔除跑题闲聊与噪音、不要复述无关内容。只输出交接文档本身。",
      [{ role: "user", content: [{ type: "text", text: `工作对话原文：\n${transcript}\n\n请输出交接文档：` }] }],
      [],
      {},
    );
    return res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
  }

  // 让历史能安全接受新的 user 消息：修好上一轮中断残留的尾部，避免连续 user / 悬空 tool_use 致 API 400
  private ensureCanAcceptUser(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    if (last.role === "assistant") {
      // 悬空 tool_use(没配对 tool_result 会 400)→ 只剥掉 tool_use 块，保留已写的文字，别把整段回复丢了
      const hasToolUse = last.content.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        const keptText = last.content.filter((b) => b.type === "text" && (b as any).text?.trim());
        this.messages[this.messages.length - 1] = {
          role: "assistant",
          content: keptText.length ? keptText : [{ type: "text", text: "(已停止)" }],
        };
      }
      return;
    }
    // 末尾是 user(被中断未应答 / tool_result 结尾)→ 补一条占位 assistant 维持 user/assistant 交替
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "(已停止)" }] });
  }

  // —— 上下文压缩 ——
  // 粗估"当前若立刻发请求"的输入 token(system + tools + 全部历史)。
  // ★关键:发请求前用它判断该不该压缩,而不是只信"上一轮成功返回的 input tokens"——
  // 后者在请求失败(如 prompt too long)时不更新,会把压缩逻辑永久冻住导致死锁。
  private estimateContextTokens(): number {
    let n = estimateText(this.system);
    for (const t of this.tools)
      n += estimateText(t.name) + estimateText(t.description) + estimateText(JSON.stringify(t.inputSchema || {}));
    for (const m of this.messages) n += estimateMsgTokens(m);
    return Math.round(n);
  }

  private async maybeCompact(hooks: AgentHooks): Promise<void> {
    if (this.compactThreshold <= 0) return;
    // 取"上一轮成功值"与"当前实时估算"的较大者:成功值准但可能过时,估算值防它过时导致漏压。
    const trigger = Math.max(this.usage.lastInput, this.estimateContextTokens());
    if (trigger < this.compactThreshold) return;
    await this.compactOnce(hooks, this.keepRecent);
  }

  // 执行一次压缩:把安全切点之前的旧历史摘要成一条 user 消息,保留最近 keepN 条原始消息。
  // 返回是否真的压了(找不到切点/摘要失败→false,绝不丢历史)。
  private async compactOnce(hooks: AgentHooks, keepN: number): Promise<boolean> {
    if (this.messages.length <= keepN + 1) return false;

    const cut = this.findCutIndex(keepN);
    if (cut <= 0) return false; // 找不到安全切点则不压

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const before = this.messages.length;

    // 把旧历史摊平成文本摘录(含工具调用/结果的要点)，作为单条 user 消息去总结——
    // 比直接把原始消息(可能含未配对工具块)喂给模型稳得多，也更信息量足。
    let transcript = older
      .map((m) => {
        const parts = (m.content || [])
          .map((b: any) => {
            if (b.type === "text") return b.text;
            if (b.type === "tool_use") return `[调用 ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`;
            if (b.type === "tool_result") return `[结果: ${String(b.content).slice(0, 500)}]`;
            if (b.type === "image") return "[图片]";
            return "";
          })
          .filter(Boolean)
          .join("\n");
        return parts ? `${m.role === "user" ? "用户" : "助手"}：${parts}` : "";
      })
      .filter((s) => s.length > 3)
      .join("\n\n");
    // 历史特别大时,摘要请求本身也可能撑爆→掐头留尾(目标在开头、最新进展在结尾)
    const MAX = 120000;
    if (transcript.length > MAX)
      transcript = transcript.slice(0, 18000) + "\n\n…(中间大段略去)…\n\n" + transcript.slice(-(MAX - 18000));

    let summaryText = "";
    try {
      const res = await this.provider.complete(
        "你是对话摘要器。把下面这段对话历史压缩成简洁但具体的中文要点摘要，务必保留：用户目标、" +
          "已完成的关键操作、涉及的文件/命令/参数/机器、关键结论与数据、当前进展、未决事项与下一步。" +
          "条列式，带上具体名字(别泛泛而谈)。只输出摘要本身。",
        [{ role: "user", content: [{ type: "text", text: `对话历史：\n${transcript}\n\n请输出要点摘要：` }] }],
        [],
        {},
      );
      if (res.usage) {
        this.usage.totalInput += res.usage.inputTokens;
        this.usage.totalOutput += res.usage.outputTokens;
        this.usage.totalCacheHit += res.usage.cacheHitTokens ?? 0;
        this.usage.totalCacheMiss +=
          res.usage.cacheMissTokens ??
          Math.max(0, res.usage.inputTokens - (res.usage.cacheHitTokens ?? 0));
      }
      summaryText = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
    } catch {
      summaryText = ""; // 生成失败 → 下面直接放弃本次压缩，绝不丢历史
    }

    // ⚠ 摘要为空/失败：宁可不压、也不能把历史丢成空摘要(否则 AI 直接失忆)
    if (!summaryText) return false;

    this.messages = [
      { role: "user", content: [{ type: "text", text: `【之前对话摘要】\n${summaryText}` }] },
      ...recent,
    ];
    // 压缩后当前上下文变小，重置 lastInput 让下轮重新度量
    this.usage.lastInput = 0;
    hooks.onCompact?.(before, this.messages.length);
    return true;
  }

  // 撞上下文上限后的紧急瘦身:普通压缩(阈值触发)已经不够了,这里更激进——
  // ①逐级调小保留条数强制摘要;②仍超则硬砍保留区里的巨型 tool_result / 丢图片 / 截超长文本。
  // 返回是否真的变小了(变小才允许重试;砍无可砍→false→把原始错误抛给用户)。
  private async emergencyShrink(hooks: AgentHooks): Promise<boolean> {
    const before = this.estimateContextTokens();
    for (const keepN of [this.keepRecent, 6, 3, 1]) {
      if (await this.compactOnce(hooks, keepN)) {
        if (this.estimateContextTokens() < this.compactThreshold) return true;
      }
    }
    // 摘要已到极限仍超(通常是保留区里单条巨物:大文件读取结果/图片/超长粘贴)→ 硬砍
    const shrank = this.shrinkOversized();
    return shrank || this.estimateContextTokens() < before;
  }

  // 硬砍历史里的巨型内容块(仅在紧急瘦身时用):截断超长 tool_result / 文本,丢弃图片。
  // 不动最后一条消息里的文字(可能是用户本轮刚输入的);tool_use/tool_result 配对不受影响(只改内容长度)。
  private shrinkOversized(): boolean {
    const TOOL_CAP = 8000; // 单条工具结果保留字符上限
    const TEXT_CAP = 40000; // 单条历史文本保留字符上限(兜底,极少触发)
    const lastIdx = this.messages.length - 1;
    let changed = false;
    for (let i = 0; i < this.messages.length; i++) {
      const content = this.messages[i].content as ContentBlock[];
      for (let j = 0; j < content.length; j++) {
        const b = content[j];
        if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > TOOL_CAP) {
          b.content = b.content.slice(0, TOOL_CAP) + "\n…(结果过长，为控制上下文已截断)…";
          changed = true;
        } else if (b.type === "image") {
          content[j] = { type: "text", text: "[图片已省略以控制上下文]" };
          changed = true;
        } else if (b.type === "text" && i !== lastIdx && b.text.length > TEXT_CAP) {
          b.text = b.text.slice(0, TEXT_CAP) + "\n…(内容过长，为控制上下文已截断)…";
          changed = true;
        }
      }
    }
    return changed;
  }

  // 找安全切点：从"倒数第 keepN 条"往前找最近的"真正用户输入"边界，
  // 保证保留 >= keepN 条最近消息(不会像以前往后找越留越少)，且不拆散 tool_use/tool_result。
  private findCutIndex(keepN: number = this.keepRecent): number {
    const target = Math.min(this.messages.length - keepN, this.messages.length - 1);
    for (let i = target; i >= 1; i--) {
      const m = this.messages[i];
      if (m.role === "user" && m.content.every((b) => b.type === "text")) return i;
    }
    return -1; // 前面没有干净的用户边界(极少)，放弃本次压缩
  }
}
