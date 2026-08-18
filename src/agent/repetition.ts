// 退化重复守卫：模型偶发陷入「把同一个词/行不停刷向 max_tokens」的死循环
//（如屏上狂刷 "count\ncount\ncount…"，Claude Code 也会偶发）。词一旦开始重复只会越滚越多、
// 直到把这次回复撑爆/失控，所以要「一冒头就掐」：
//   1) 流式解码时实时检测末尾是否变成「短单元连续重复十几遍」，是则让 provider 立刻中止本次流，
//      不再白跑到 max_tokens（早停几十字符即中止，而非等到几百遍上千字符）。
//   2) 落库/展示前把这次回复里重复的那一整段直接删掉，只留正文 + 一句提示——
//      屏上(经 onRecover)和历史都干净，下一轮模型也不会顺着旧输出继续刷。
//
// 判定核心：只认「精确周期重复」。为不误伤合法重复：
//   · 单字符周期(period=1，如分隔线 "------"、省略号 "……"、进度条 "██")门槛高（≥120 字符）；
//   · 多字符单元(period≥2，如 "count"/"count\n"/"ha ")连续 ≥12 遍即判定——正常文字/代码几乎不会
//     把同一个 ≥2 字符的串精确重复十几遍，故极少误伤；一旦误伤最坏也只是把已明显跑飞的回答早点截断。

export interface RepeatHit {
  period: number; // 重复单元长度（字符）
  run: number; // 末尾精确重复的字符数（≈(遍数-1)*period）
  repStart: number; // 重复段在原串中的起点下标（含）
}

// 从末尾往前找「精确周期重复」的最长游程。对每个候选周期 p，数 s[i]===s[i-p] 的连续命中数；
// 命中越长=重复越死。取「最小周期」里第一个达标的（退化循环的周期通常很小）。
export function findRepeatSuffix(s: string, maxPeriod = 200, win = 8192): RepeatHit | null {
  const L = s.length;
  if (L < 3) return null;
  const lo = Math.max(0, L - win); // 只看末尾 win 字符，够判定且开销可控
  const maxP = Math.min(maxPeriod, L - lo - 1);
  for (let p = 1; p <= maxP; p++) {
    let run = 0;
    for (let i = L - 1; i - p >= lo && s[i] === s[i - p]; i--) run++;
    if (run <= 0) continue;
    const repeats = run / p + 1; // 连续出现的单元遍数（近似）
    // 单字符周期易撞合法重复(分隔线/省略号/进度条/单字叠词)→ 要够长；多字符单元约十遍即判定，冒头就抓
    const qualifies = p === 1 ? run >= 120 : repeats >= 10 && run >= 20;
    if (qualifies) {
      const repStart = Math.max(0, L - (run + p)); // 末尾 run+p 字符 = 单元×多遍
      return { period: p, run, repStart };
    }
  }
  return null;
}

// 流式增量检测器：provider 每收到一段文本 delta 就 push；返回 true 表示已确认退化重复，
// 调用方应立刻中止本次流（abort / cancel reader）。tripped 后恒返回 true，只触发一次。
export class RepetitionGuard {
  private text = "";
  private lastCheckLen = 0;
  private tripped = false;
  constructor(
    private maxPeriod = 200, // 重复单元最长这么多字符
    private checkEvery = 32, // 每新增这么多字符查一次（够密，冒头即抓；又不必每 delta 都扫）
  ) {}

  push(delta: string): boolean {
    if (this.tripped) return true;
    if (delta) this.text += delta;
    if (this.text.length - this.lastCheckLen < this.checkEvery) return false;
    this.lastCheckLen = this.text.length;
    if (findRepeatSuffix(this.text, this.maxPeriod)) this.tripped = true;
    return this.tripped;
  }

  didTrip(): boolean {
    return this.tripped;
  }
}

export const REPEAT_TRUNC_NOTE = "\n…（检测到模型陷入重复输出，已自动截断）";

// 落库/展示前清理：若文本末尾是退化重复，直接删掉重复的那一整段，只留前面的正文 + 提示。
// 返回清理后的新文本；未检测到重复则返回 null（调用方据此判断是否需要替换/通知前端刷新）。
export function collapseRepeatedText(text: string, maxPeriod = 200): string | null {
  if (!text) return null;
  const hit = findRepeatSuffix(text, maxPeriod);
  if (!hit) return null;
  const prefix = text.slice(0, hit.repStart).replace(/\s+$/, ""); // 重复段整段删掉
  return prefix + REPEAT_TRUNC_NOTE;
}
