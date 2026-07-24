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

      const toolUses = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

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
