// 多语言（i18n）。当前覆盖登录/账号/语言切换等；全量界面文案分批补进 DICT。
export type Lang = "zh" | "en";
const KEY = "wuwei_lang";

export function getLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* ignore */
  }
  // 默认跟随系统：非中文环境默认英文
  try {
    if (!navigator.language.toLowerCase().startsWith("zh")) return "en";
  } catch {
    /* ignore */
  }
  return "zh";
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
  "login.register": { zh: "注册", en: "Sign up" },
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
};

export function makeT(lang: Lang) {
  return (key: string, fallback?: string): string => DICT[key]?.[lang] ?? fallback ?? key;
}
export type T = ReturnType<typeof makeT>;
