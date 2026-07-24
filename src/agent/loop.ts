// Agent 主循环：Claude Code 的心脏。
//   组装消息 → 请求模型 → 若要调工具则执行并回灌 → 循环 → 直到模型给最终文字。
// P2：累计 token 用量 + 上下文过长时自动压缩（把旧历史总结成一段，保留最近若干条）。
import type {
  ContentBlock,
  Message,
  Provider,
  Tool,
  ToolContext,
} from "../types.js";

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
}

export interface AgentHooks {
  onText?(delta: string): void;
  requestPermission?(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision>;
  onToolStart?(id: string, name: string, input: Record<string, unknown>): void;
  onToolEnd?(id: string, result: string, isError: boolean): void;
  onAssistantDone?(): void;
  onUsage?(u: SessionUsage): void; // 每轮请求后回报累计用量
  onRateLimits?(rl: import("../types.js").RateLimits): void; // 订阅额度快照
  onCompact?(before: number, after: number): void; // 压缩发生时回报条数变化
  onStep?(): void; // 每完成一段(助手消息/工具结果)后回调：用于即时落盘，重启不丢进度
  onRecover?(cleanedText: string): void; // 模型把工具调用当文本吐出→兜底解析后，回传清理后的正文供前端修正显示
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
  };
  private compactThreshold: number;
  private keepRecent: number;
  private pendingInject: { text: string; images: string[] }[] = []; // 运行中注入的新需求，循环边界取用

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

  // 载入已保存的会话历史（切换/恢复会话时用）
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
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

  getUsage(): SessionUsage {
    return this.usage;
  }

  setUsage(u: SessionUsage): void {
    // 兼容旧会话存档（无缓存明细字段）
    this.usage = { ...u, totalCacheHit: u.totalCacheHit ?? 0, totalCacheMiss: u.totalCacheMiss ?? 0 };
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

    while (true) {
      if (signal?.aborted) return; // 已被用户中断
      // 上下文过长则先压缩，再请求模型（省 token / 防撑爆）
      await this.maybeCompact(hooks);

      const result = await this.provider.complete(this.system, this.messages, this.tools, {
        onText: hooks.onText,
        signal,
      });

      if (result.usage) {
        this.usage.totalInput += result.usage.inputTokens;
        this.usage.totalOutput += result.usage.outputTokens;
        this.usage.lastInput = result.usage.inputTokens;
        this.usage.totalCacheHit += result.usage.cacheHitTokens ?? 0;
        this.usage.totalCacheMiss +=
          result.usage.cacheMissTokens ??
          Math.max(0, result.usage.inputTokens - (result.usage.cacheHitTokens ?? 0));
        hooks.onUsage?.(this.usage);
      }
      if (result.rateLimits) hooks.onRateLimits?.(result.rateLimits);

      this.messages.push({ role: "assistant", content: result.content, ts: Date.now() });
      hooks.onStep?.(); // 助手段落已入历史，即时落盘(重启不丢)

      let toolUses = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      // 兜底：没有结构化 tool_use 时，看是否把工具调用当文本写出来了(<invoke …>)，是则解析回来执行、继续跑
      if (toolUses.length === 0) {
        const recovered = recoverLeakedToolCalls(result.content);
        if (recovered) {
          toolUses = recovered.toolUses;
          this.messages[this.messages.length - 1] = {
            role: "assistant",
            content: recovered.newContent,
            ts: Date.now(),
          };
          const cleaned = recovered.newContent.find((b) => b.type === "text") as any;
          hooks.onRecover?.(cleaned?.text || ""); // 让前端把屏上那串 XML 换成干净正文
        }
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

  // 让历史能安全接受新的 user 消息：修好上一轮中断残留的尾部，避免连续 user / 悬空 tool_use 致 API 400
  private ensureCanAcceptUser(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    if (last.role === "assistant") {
      // 悬空 tool_use(没配对 tool_result)→ 换成占位文本，避免 API 报 tool_use 无结果
      const hasToolUse = last.content.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        this.messages[this.messages.length - 1] = {
          role: "assistant",
          content: [{ type: "text", text: "(已停止)" }],
        };
      }
      return;
    }
    // 末尾是 user(被中断未应答 / tool_result 结尾)→ 补一条占位 assistant 维持 user/assistant 交替
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "(已停止)" }] });
  }

  // —— 上下文压缩 ——
  private async maybeCompact(hooks: AgentHooks): Promise<void> {
    if (this.compactThreshold <= 0) return;
    if (this.usage.lastInput < this.compactThreshold) return;
    if (this.messages.length <= this.keepRecent + 1) return;

    const cut = this.findCutIndex();
    if (cut <= 0) return; // 找不到安全切点则不压

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const before = this.messages.length;

    // 让模型把旧历史总结成要点（单独一次调用，不带工具）
    const summaryPrompt =
      "把下面这段对话历史压缩成简洁的要点摘要，保留：用户目标、已做的关键操作、涉及的文件/命令、当前进展与未决事项。用中文，条列式。";
    const res = await this.provider.complete(
      summaryPrompt,
      older,
      [],
      {}, // 不流式回显摘要生成
    );
    if (res.usage) {
      this.usage.totalInput += res.usage.inputTokens;
      this.usage.totalOutput += res.usage.outputTokens;
      this.usage.totalCacheHit += res.usage.cacheHitTokens ?? 0;
      this.usage.totalCacheMiss +=
        res.usage.cacheMissTokens ??
        Math.max(0, res.usage.inputTokens - (res.usage.cacheHitTokens ?? 0));
    }
    const summaryText =
      res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("") || "(摘要为空)";

    this.messages = [
      { role: "user", content: [{ type: "text", text: `【之前对话摘要】\n${summaryText}` }] },
      ...recent,
    ];
    // 压缩后当前上下文变小，重置 lastInput 让下轮重新度量
    this.usage.lastInput = 0;
    hooks.onCompact?.(before, this.messages.length);
  }

  // 找一个安全切点：保留最近 keepRecent 条，且切点落在一个"真正的用户输入"上，
  // 不能把 assistant 的 tool_use 与其对应的 tool_result 拆开。
  private findCutIndex(): number {
    const target = this.messages.length - this.keepRecent;
    for (let i = target; i < this.messages.length; i++) {
      const m = this.messages[i];
      const isRealUser =
        m.role === "user" && m.content.every((b) => b.type === "text");
      if (isRealUser) return i;
    }
    return -1; // 最近段里没有干净的用户边界，放弃本次压缩
  }
}
