// 多语言（i18n）。当前覆盖登录/账号/语言切换等；全量界面文案分批补进 DICT。
export type Lang = "zh" | "en";
const KEY = "wuwei_lang";

export function getLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en") return v; // 用户在设置里手动选过 → 尊重
  } catch {
    /* ignore */
  }
  // 未手动设置：按地区自动。中国(时区/语言)→中文，其它→英文。
  // 用时区做地区代理(离线、无需外部 IP 服务、不涉隐私)，配合系统语言兜底。
  try {
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
    if (/shanghai|chongqing|harbin|urumqi|kashgar|hong_kong|macau|taipei/.test(tz)) return "zh";
    if (navigator.language.toLowerCase().startsWith("zh")) return "zh";
    return "en";
  } catch {
    return "en";
  }
}
export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
}

const DICT: Record<string, { zh: string; en: string }> = {
  "login.title": { zh: "登录 / 注册无为账号", en: "Sign in to Wuwei" },
  "login.incentive": { zh: "注册即得 100 无为币 · 每日签到再领 10", en: "Get 100 credits on sign-up · +10 daily check-in" },
  "login.freeModels": { zh: "免费使用最新顶级模型", en: "Use the latest top-tier models for free" },
  "login.tab.email": { zh: "邮箱", en: "Email" },
  "login.tab.phone": { zh: "手机号", en: "Phone" },
  "login.email": { zh: "邮箱", en: "Email" },
  "login.phone": { zh: "手机号", en: "Phone" },
  "login.password": { zh: "密码", en: "Password" },
  "login.setPassword": { zh: "设置密码", en: "Set a password" },
  "login.code": { zh: "验证码", en: "Verification code" },
  "login.emailCode": { zh: "邮箱验证码", en: "Email code" },
  "login.getCode": { zh: "获取验证码", en: "Send code" },
  "login.autoRegister": { zh: "没有账号将自动注册", en: "New number will be registered automatically" },
  "login.toRegister": { zh: "没有账号？邮箱注册", en: "No account? Sign up with email" },
  "login.toLogin": { zh: "已有账号，去登录", en: "Have an account? Sign in" },
  "login.submit": { zh: "登录 / 注册", en: "Continue" },
  "login.signin": { zh: "登录", en: "Sign in" },
  "login.register": { zh: "注册", en: "Sign up" },
  "login.noAccount": { zh: "还没账号？立即注册", en: "No account? Sign up" },
  "login.haveAccount": { zh: "已有账号？去登录", en: "Have an account? Sign in" },
  "login.busy": { zh: "处理中…", en: "Processing…" },
  "login.or": { zh: "或", en: "or" },
  "login.google": { zh: "用 Google 登录（浏览器）", en: "Continue with Google" },
  "login.wechat": { zh: "微信登录（即将支持）", en: "WeChat (coming soon)" },
  "login.needEmail": { zh: "请输入邮箱", en: "Enter your email" },
  "login.needPhone": { zh: "请输入手机号", en: "Enter your phone number" },
  "acct.guest": { zh: "游客", en: "Guest" },
  "acct.notLoggedIn": { zh: "游客（未登录）", en: "Guest (not signed in)" },
  "acct.settings": { zh: "设置", en: "Settings" },
  "acct.logout": { zh: "退出", en: "Sign out" },
  "acct.language": { zh: "语言", en: "Language" },
  "acct.guestIncentive": { zh: "无为币", en: "credits" },
  "composer.placeholder": {
    zh: "描述你的需求…（可直接粘贴图片；/reset 清空对话）",
    en: "Describe what you need… (paste images; /reset to clear)",
  },
  "session.new": { zh: "＋ 新对话", en: "＋ New chat" },
  "foot.browser": { zh: "浏览器", en: "Browser" },
  "foot.ready": { zh: "就绪", en: "Ready" },
  "foot.context": { zh: "上下文", en: "Context" },
  "mode.auto": { zh: "自动", en: "Auto" },
  "mode.manual": { zh: "手动", en: "Manual" },
  "mode.autoTip": { zh: "工具自动放行", en: "Tools auto-approved" },
  "mode.manualTip": { zh: "每步需确认", en: "Confirm each step" },
  "foot.running": { zh: "运行中", en: "Running" },
  "foot.bgRunning": { zh: "后台运行中", en: "Running in background" },
  "foot.tasksSuffix": { zh: "个任务运行中", en: "tasks running" },
  "set.title": { zh: "设置", en: "Settings" },
  "set.tab.general": { zh: "通用", en: "General" },
  "set.tab.display": { zh: "外观", en: "Appearance" },
  "set.tab.model": { zh: "模型", en: "Model" },
  "set.tab.platforms": { zh: "平台管理", en: "Platforms" },
  "set.tab.prompt": { zh: "系统提示词", en: "System Prompt" },
  "set.tab.memory": { zh: "记忆", en: "Memory" },
  "set.tab.brain": { zh: "知识网络", en: "Knowledge" },
  "set.tab.mcp": { zh: "MCP", en: "MCP" },
  "set.tab.tools": { zh: "工具", en: "Tools" },
  "set.tab.secrets": { zh: "密钥", en: "Secrets" },
  // 通用 tab
  "set.g.grouping": { zh: "会话分组", en: "Session grouping" },
  "set.g.manual": { zh: "手动分组", en: "Manual" },
  "set.g.byDate": { zh: "按日期", en: "By date" },
  "set.g.byProject": { zh: "按项目", en: "By project" },
  "set.g.groupingHint": {
    zh: "手动：右键会话移动/新建分组、可拖拽排序；按日期/按项目：自动分组（项目名由 AI 按会话内容归纳）。",
    en: "Manual: right-click to move/create groups & drag to reorder. By date/project: auto-grouped (project name summarized by AI).",
  },
  "set.g.compaction": { zh: "上下文压缩", en: "Context compaction" },
  "set.g.keepRecent": { zh: "保留最近条数", en: "Keep recent messages" },
  "set.g.items": { zh: "条", en: "" },
  "set.g.compactionHint": {
    zh: "上下文超限时，会把更早的消息总结成要点摘要、保留最近这么多条原文。数字越大越不易“失忆”，但更费上下文。",
    en: "When context is exceeded, older messages are summarized and this many recent ones kept verbatim. Higher = less “forgetting” but uses more context.",
  },
  "set.g.claudeSub": { zh: "Claude 订阅", en: "Claude subscription" },
  "set.g.autoRead": { zh: "账号信息自动读取", en: "Account auto-detected" },
  "set.g.autoReadHint": {
    zh: "用户名 / 邮箱 / 套餐直接从本机 Claude Code 配置（~/.claude.json）读取，随 Claude Code 自动保持最新，无需登录或填 token。额度（5小时/周）发消息后从响应头刷新。",
    en: "Username / email / plan are read from your local Claude Code config (~/.claude.json), always current, no login or token needed. Quota (5h/week) refreshes from response headers after messages.",
  },
  // 外观 tab
  "set.d.output": { zh: "输出方式", en: "Output style" },
  "set.d.stream": { zh: "流式（一下出）", en: "Stream (batch)" },
  "set.d.typewriter": { zh: "打字机（匀速）", en: "Typewriter" },
  "set.d.instant": { zh: "回完一次性", en: "On complete" },
  "set.d.outputHint": {
    zh: "流式=收到即刻整批显示；打字机=匀速逐字，最丝滑；回完一次性=回复期间不显示、完成后整段出。",
    en: "Stream: show as received; Typewriter: even-paced, smoothest; On complete: hidden while replying, shown all at once.",
  },
  "set.d.typeSpeed": { zh: "打字机速度", en: "Typewriter speed" },
  "set.d.cps": { zh: "字/秒", en: "cps" },
  "set.d.theme": { zh: "界面主题", en: "Theme" },
  "set.d.dark": { zh: "暗色", en: "Dark" },
  "set.d.light": { zh: "白色", en: "Light" },
  "set.d.gold": { zh: "淡金", en: "Gold" },
  // 模型 tab
  "set.m.platform": { zh: "模型平台", en: "Provider" },
  "set.m.addStation": { zh: "＋ 添加中转站", en: "＋ Add relay" },
  "set.m.delete": { zh: "删除", en: "Delete" },
  "set.m.model": { zh: "模型", en: "Model" },
  "set.m.custom": { zh: "自定义 / 其它…", en: "Custom / other…" },
  "set.m.modelPlaceholder": { zh: "模型名（直接输入）", en: "Model name (type it)" },
  "set.m.noKey": { zh: "没有 API Key？", en: "No API key?" },
  "set.m.getKeySteps": {
    zh: "（登录 → 创建 API Key → 复制，回来自动检测设置）",
    en: "(Sign in → create API key → copy; it's auto-detected here)",
  },
  "set.m.verifyNow": { zh: "立即验证已填入的", en: "Verify now" },
  "set.m.oauthCodeHint": {
    zh: "浏览器里登录并点“同意”后，复制页面显示的授权码粘到下方（留空则自动读剪贴板），再点完成。",
    en: "Sign in in the browser and click “Allow”, then paste the code below (or leave blank to read clipboard) and finish.",
  },
  "set.m.pasteCode": { zh: "粘贴授权码（可留空自动读剪贴板）", en: "Paste code (blank = read clipboard)" },
  "set.m.verifying": { zh: "校验中…", en: "Verifying…" },
  "set.m.completeAuth": { zh: "完成授权", en: "Finish" },
  "set.m.back": { zh: "返回", en: "Back" },
  "set.m.authBrowser": { zh: "🔑 一键授权（用浏览器登录）", en: "🔑 Authorize (sign in via browser)" },
  "set.m.useInApp": { zh: "改用应用内窗口登录", en: "Use in-app window instead" },
  "set.m.oauthToken": { zh: "OAuth Token（一键授权会自动填，也可手动粘贴）", en: "OAuth Token (auto-filled, or paste manually)" },
  "set.m.hide": { zh: "隐藏", en: "Hide" },
  "set.m.show": { zh: "显示", en: "Show" },
  "set.m.codexAuthing": { zh: "🔑 授权中…（浏览器完成登录）", en: "🔑 Authorizing… (finish in browser)" },
  "set.m.codexAuth": { zh: "🔑 一键授权（ChatGPT 登录）", en: "🔑 Authorize (ChatGPT login)" },
  "set.m.apiKey": { zh: "API Key", en: "API Key" },
  "set.save": { zh: "保存并切换", en: "Save & switch" },
  "set.saveOnly": { zh: "保存", en: "Save" },
  "set.cancel": { zh: "取消", en: "Cancel" },
  // 平台管理 tab
  "set.p.hint": {
    zh: "拖动 ⋮⋮ 排序，点眼睛隐藏/显示。改动即时保存；隐藏仅影响底部「切换平台」菜单，此处仍可恢复。",
    en: "Drag ⋮⋮ to reorder, click the eye to hide/show. Saved instantly; hiding only affects the bottom “Switch provider” menu and can be restored here.",
  },
  "set.p.dragSort": { zh: "拖动排序", en: "Drag to reorder" },
  "set.p.lockOn": { zh: "当前使用中的平台不可隐藏", en: "Current provider can't be hidden" },
  "set.p.hiddenClickShow": { zh: "已隐藏，点击显示", en: "Hidden — click to show" },
  "set.p.clickHide": { zh: "点击隐藏", en: "Click to hide" },
  // 系统提示词 tab
  "set.pr.globalPrompt": { zh: "全局默认提示词（所有平台通用）", en: "Global default prompt (all providers)" },
  "set.pr.customized": { zh: "（已自定义）", en: " (customized)" },
  "set.pr.default": { zh: "（默认）", en: " (default)" },
  "set.pr.emptyHint": { zh: "（留空 = 不发系统提示词）", en: "(blank = no system prompt)" },
  "set.pr.restore": { zh: "恢复默认", en: "Restore default" },
  "set.pr.overrideLabelSuffix": { zh: "专属提示词", en: " prompt" },
  "set.pr.overridePlaceholder": {
    zh: "（本平台专属；留空 = 本平台不发系统提示词）",
    en: "(this provider only; blank = no system prompt for it)",
  },
  // 记忆 tab
  "set.mem.global": { zh: "全局长期记忆（所有会话共享）", en: "Global long-term memory (shared by all chats)" },
  "set.mem.placeholder": {
    zh: "每行一条，例如：\n- 始终用中文回复\n- 我叫 Logic，做后端\n- 部署脚本在 delopy_batch/",
    en: "One per line, e.g.:\n- Always reply in English\n- I'm Logic, a backend dev\n- Deploy scripts are in deploy_batch/",
  },
};

export function makeT(lang: Lang) {
  return (key: string, fallback?: string): string => DICT[key]?.[lang] ?? fallback ?? key;
}
export type T = ReturnType<typeof makeT>;
