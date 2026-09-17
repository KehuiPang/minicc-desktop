// chrome_* 工具：控制「调试模式 Chrome」——走 Chrome DevTools Protocol(CDP)。
// 与内置 browser_*(Electron WebContentsView) 不同：这套连的是真实 Chrome 实例
// (带用户登录态/插件)，通过 --remote-debugging-port 暴露的 HTTP(/json) + WebSocket 驱动。
// 能力：启动/连接/关闭、列标签、开标签、读正文、找元素、点击、填表单、提交、滚动、截屏理解。
//
// 实现要点：大部分交互(读/找/点/填/滚)统一用 Runtime.evaluate 在页面里跑 JS 完成——
// 比按坐标派发鼠标事件更稳、跨页面通用；导航用 location.assign；截屏用 Page.captureScreenshot。
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "../types.js";

// ---- 连接状态(模块级) ----
const state: { port: number; selectedTargetId?: string } = { port: 9222 };
const DEFAULT_PROFILE = join(homedir(), ".minicc", "chrome-debug");

function base(): string {
  return `http://127.0.0.1:${state.port}`;
}

async function httpJson(path: string, method: "GET" | "PUT" = "GET"): Promise<any> {
  const res = await fetch(base() + path, { method });
  const txt = await res.text();
  try {
    return txt ? JSON.parse(txt) : {};
  } catch {
    return txt;
  }
}

async function isUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(base() + "/json/version", { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

type CdpTarget = { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string };

async function listPages(): Promise<CdpTarget[]> {
  const all = (await httpJson("/json")) as CdpTarget[];
  return Array.isArray(all) ? all.filter((t) => t.type === "page" && t.webSocketDebuggerUrl) : [];
}

// 选一个标签页的调试 WebSocket：优先 state.selectedTargetId，否则取第一个 page
async function pickWs(): Promise<{ wsUrl: string; target: CdpTarget }> {
  const pages = await listPages();
  if (!pages.length) throw new Error("没有可控制的标签页(先 chrome_launch，或在 Chrome 里开个页面)");
  let target = state.selectedTargetId ? pages.find((p) => p.id === state.selectedTargetId) : undefined;
  if (!target) target = pages[0];
  state.selectedTargetId = target.id;
  return { wsUrl: target.webSocketDebuggerUrl!, target };
}

// 向某个 CDP 端点发一条命令，等匹配 id 的回复。用 Node/Electron 内置全局 WebSocket。
function cdpSend(wsUrl: string, method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`CDP 超时: ${method}`))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onerror = () => finish(() => reject(new Error(`CDP 连接失败: ${wsUrl}`)));
    ws.onmessage = (ev: any) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== id) return; // 忽略事件/其它命令回包
      if (msg.error) finish(() => reject(new Error(msg.error.message || "CDP 错误")));
      else finish(() => resolve(msg.result));
    };
  });
}

// 在当前(选中)标签页里执行 JS，返回其值(returnByValue)。awaitPromise 支持 async 表达式。
async function evalInPage(expression: string, timeoutMs = 30000): Promise<any> {
  const { wsUrl } = await pickWs();
  const r = await cdpSend(
    wsUrl,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    timeoutMs,
  );
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || "页面 JS 执行异常");
  }
  return r?.result?.value;
}

// ---- 注入到页面的辅助 JS(生成唯一选择器 / 收集可交互元素) ----
// 给一个元素生成较稳的 CSS 路径(优先 id，其次 tag+nth-of-type 链)。
const JS_HELPERS = `
(function(){
  if (window.__miniccHelpers) return;
  function cssPath(el){
    if(!(el instanceof Element)) return '';
    if(el.id) return '#'+CSS.escape(el.id);
    var parts=[];
    while(el && el.nodeType===1 && parts.length<6){
      var sel=el.tagName.toLowerCase();
      if(el.id){ parts.unshift('#'+CSS.escape(el.id)); break; }
      var p=el.parentElement;
      if(p){
        var same=Array.prototype.filter.call(p.children,function(c){return c.tagName===el.tagName;});
        if(same.length>1) sel+=':nth-of-type('+(same.indexOf(el)+1)+')';
      }
      parts.unshift(sel);
      el=el.parentElement;
    }
    return parts.join('>');
  }
  function visible(el){
    var r=el.getBoundingClientRect();
    if(r.width<1||r.height<1) return false;
    var s=getComputedStyle(el);
    return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
  }
  function label(el){
    var t=(el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||el.title||el.name||'').trim();
    return t.replace(/\\s+/g,' ').slice(0,80);
  }
  window.__miniccHelpers={cssPath:cssPath,visible:visible,label:label};
})();
`;

// 收集可交互元素(点击类 + 输入类)，返回 [{tag,type,text,selector}]
function jsCollectInteractive(limit: number): string {
  return `${JS_HELPERS}
  (function(){
    var H=window.__miniccHelpers;
    var sel='a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[tabindex]';
    var els=Array.prototype.slice.call(document.querySelectorAll(sel));
    var out=[];
    for(var i=0;i<els.length && out.length<${limit};i++){
      var el=els[i];
      if(!H.visible(el)) continue;
      out.push({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',text:H.label(el),selector:H.cssPath(el)});
    }
    return out;
  })();`;
}

// 按文本/选择器查找可交互元素
function jsFind(query: string, limit: number): string {
  return `${JS_HELPERS}
  (function(){
    var H=window.__miniccHelpers;
    var q=${JSON.stringify(query)};
    var out=[];
    // 先当 CSS 选择器试
    try{
      var bySel=document.querySelectorAll(q);
      for(var i=0;i<bySel.length && out.length<${limit};i++){
        var e=bySel[i]; if(!H.visible(e)) continue;
        out.push({tag:e.tagName.toLowerCase(),text:H.label(e),selector:H.cssPath(e),via:'selector'});
      }
    }catch(_){}
    if(out.length) return out;
    // 再按可见文本模糊匹配
    var ql=q.toLowerCase();
    var all=Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[onclick],label,li,td,th,span,div'));
    for(var j=0;j<all.length && out.length<${limit};j++){
      var el=all[j]; if(!H.visible(el)) continue;
      var t=H.label(el); if(!t) continue;
      if(t.toLowerCase().indexOf(ql)>=0) out.push({tag:el.tagName.toLowerCase(),text:t,selector:H.cssPath(el),via:'text'});
    }
    return out;
  })();`;
}

function fmtList(items: any[]): string {
  if (!Array.isArray(items) || !items.length) return "(无)";
  return items
    .map((it, i) => `${i + 1}. <${it.tag}${it.type ? " type=" + it.type : ""}> ${it.text || "(无文字)"}\n   selector: ${it.selector}`)
    .join("\n");
}

// ================= 工具定义 =================

const launchTool: Tool = {
  name: "chrome_launch",
  description:
    "启动或连接『调试模式 Chrome』(默认端口 9222)。若该端口已有调试 Chrome 则直接连接；否则用独立调试配置目录新开一个 Chrome。之后用 chrome_tabs/chrome_open/chrome_click 等控制它。想用你平时带登录态的真实配置，传 use_default_profile=true(需先完全退出 Chrome)。",
  readOnly: false, // 会拉起进程
  inputSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "调试端口，默认 9222" },
      use_default_profile: { type: "boolean", description: "是否使用系统默认 Chrome 配置(带登录态)，需先退出 Chrome。默认 false(独立调试配置)" },
      url: { type: "string", description: "启动后要打开的首个 URL，可选" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      if (input.port) state.port = Number(input.port);
      if (await isUp()) {
        const v = await httpJson("/json/version");
        return { content: `已连接现有调试 Chrome(端口 ${state.port})：${v.Browser || ""}` };
      }
      const useDefault = !!input.use_default_profile;
      const profileDir = useDefault ? join(homedir(), "Library/Application Support/Google/Chrome") : DEFAULT_PROFILE;
      const args = [
        "-na",
        "Google Chrome",
        "--args",
        `--remote-debugging-port=${state.port}`,
        // 新版 Chrome(>111)对带 Origin 的调试连接做同源校验；放开来源，否则 Node 侧 WebSocket 可能被 403 挡
        "--remote-allow-origins=*",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ];
      if (input.url) args.push(String(input.url));
      spawn("open", args, { detached: true, stdio: "ignore" }).unref();
      // 轮询等端口起来(最多 ~12s)
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await isUp()) {
          const v = await httpJson("/json/version");
          return {
            content: `已启动调试 Chrome(端口 ${state.port}${useDefault ? "，默认配置" : "，独立调试配置"})：${v.Browser || ""}`,
          };
        }
      }
      return {
        content: `Chrome 已拉起但端口 ${state.port} 未就绪。若你平时已开着 Chrome，请先完全退出再重试，或 use_default_profile 保持 false 用独立配置。`,
        isError: true,
      };
    } catch (e: any) {
      return { content: `启动/连接失败: ${e.message}`, isError: true };
    }
  },
};

const tabsTool: Tool = {
  name: "chrome_tabs",
  description: "列出调试 Chrome 当前所有标签页(序号/标题/URL)。当前被控制的标签页会标 ← 当前。",
  readOnly: true,
  inputSchema: { type: "object", properties: {} },
  async run(): Promise<ToolResult> {
    try {
      const pages = await listPages();
      if (!pages.length) return { content: "(没有标签页)" };
      const lines = pages.map(
        (p, i) => `${i + 1}. ${p.title || "(无标题)"}\n   ${p.url}\n   id=${p.id}${p.id === state.selectedTargetId ? "  ← 当前" : ""}`,
      );
      return { content: lines.join("\n") };
    } catch (e: any) {
      return { content: `列标签失败: ${e.message}(先 chrome_launch)`, isError: true };
    }
  },
};

const openTool: Tool = {
  name: "chrome_open",
  description:
    "在调试 Chrome 里打开网页：给 url 则在当前标签导航到它(new_tab=true 则新开标签)；或给 tab_id/tab_index 切换到某个已存在标签作为当前操作对象。打开后可 chrome_read/chrome_find/chrome_click。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要打开的 URL(http/https)" },
      new_tab: { type: "boolean", description: "为 url 新开一个标签，默认 false(在当前标签导航)" },
      tab_id: { type: "string", description: "切换到该 id 的标签作为当前对象" },
      tab_index: { type: "number", description: "切换到第 N 个标签(1 基)作为当前对象" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      // 切换当前标签
      if (input.tab_id || input.tab_index) {
        const pages = await listPages();
        let t: CdpTarget | undefined;
        if (input.tab_id) t = pages.find((p) => p.id === String(input.tab_id));
        else t = pages[Number(input.tab_index) - 1];
        if (!t) return { content: "未找到指定标签", isError: true };
        state.selectedTargetId = t.id;
        await httpJson("/json/activate/" + t.id); // 前置到前台
        if (!input.url) return { content: `已切到标签：${t.title || t.url}` };
      }
      const url = input.url ? String(input.url) : "";
      if (url && !/^https?:\/\//i.test(url)) return { content: "URL 需以 http/https 开头", isError: true };
      if (url && input.new_tab) {
        // Chrome 把 ? 之后的整段当目标 URL(不要 encode)；新版要求 PUT，老版 GET，做兜底
        let t = (await httpJson("/json/new?" + url, "PUT")) as CdpTarget;
        if (!t || !t.id) t = (await httpJson("/json/new?" + url)) as CdpTarget;
        if (t?.id) state.selectedTargetId = t.id;
      } else if (url) {
        await evalInPage(`location.assign(${JSON.stringify(url)})`);
      }
      // 等加载完成(轮询 readyState)
      let title = "";
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const st = await evalInPage(`({r:document.readyState,t:document.title,u:location.href})`);
          title = st?.t || "";
          if (st?.r === "complete") return { content: `已打开：${title}（${st.u}）` };
        } catch {}
      }
      return { content: `已发起打开(可能仍在加载)：${title}` };
    } catch (e: any) {
      return { content: `打开失败: ${e.message}`, isError: true };
    }
  },
};

const readTool: Tool = {
  name: "chrome_read",
  description:
    "读取调试 Chrome 当前标签页：返回标题、URL、可见正文文本，以及可交互元素(链接/按钮/输入框)清单及其 selector——拿 selector 去 chrome_click/chrome_fill。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      max_chars: { type: "number", description: "正文最大字符数，默认 8000" },
      max_elements: { type: "number", description: "可交互元素条数上限，默认 50" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      const max = Number(input.max_chars ?? 8000);
      const info = await evalInPage(`({t:document.title,u:location.href,body:(document.body?document.body.innerText:'')})`);
      const els = await evalInPage(jsCollectInteractive(Number(input.max_elements ?? 50)));
      let body = String(info?.body || "").replace(/\n{3,}/g, "\n\n").trim();
      if (body.length > max) body = body.slice(0, max) + `\n…(已截断，共 ${body.length} 字符)`;
      return {
        content: `标题: ${info?.t || ""}\nURL: ${info?.u || ""}\n\n=== 正文 ===\n${body || "(无文本)"}\n\n=== 可交互元素 ===\n${fmtList(els)}`,
      };
    } catch (e: any) {
      return { content: `读取失败: ${e.message}(先 chrome_launch/chrome_open)`, isError: true };
    }
  },
};

const findTool: Tool = {
  name: "chrome_find",
  description: "在当前标签页查找元素：query 可以是 CSS 选择器，也可以是可见文本(模糊匹配)。返回命中元素及其 selector，供 chrome_click/chrome_fill。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "CSS 选择器或可见文本" },
      limit: { type: "number", description: "返回条数上限，默认 20" },
    },
    required: ["query"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const items = await evalInPage(jsFind(String(input.query), Number(input.limit ?? 20)));
      return { content: fmtList(items) };
    } catch (e: any) {
      return { content: `查找失败: ${e.message}`, isError: true };
    }
  },
};

const clickTool: Tool = {
  name: "chrome_click",
  description: "点击当前标签页的元素(链接/按钮等)。给 selector(CSS)优先；或给 text 按可见文本点第一个匹配项。点完可再 chrome_read 看变化。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS 选择器" },
      text: { type: "string", description: "按可见文本匹配(selector 未给时用)" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      const sel = input.selector ? String(input.selector) : "";
      const text = input.text ? String(input.text) : "";
      if (!sel && !text) return { content: "需要 selector 或 text", isError: true };
      const js = `${JS_HELPERS}(function(){
        var H=window.__miniccHelpers, el=null;
        ${sel ? `el=document.querySelector(${JSON.stringify(sel)});` : ""}
        ${
          !sel
            ? `var q=${JSON.stringify(text)}.toLowerCase();
               var all=Array.prototype.slice.call(document.querySelectorAll('a,button,input,[role=button],[role=link],[onclick],label,li,td,span,div'));
               for(var i=0;i<all.length;i++){var e=all[i];if(!H.visible(e))continue;var t=H.label(e);if(t&&t.toLowerCase().indexOf(q)>=0){el=e;break;}}`
            : ""
        }
        if(!el) return 'NOT_FOUND';
        el.scrollIntoView({block:'center'});
        el.click();
        return 'OK:'+H.label(el);
      })();`;
      const r = String(await evalInPage(js));
      if (r === "NOT_FOUND") return { content: `未找到元素(${sel || text})`, isError: true };
      return { content: `已点击：${r.slice(3) || sel || text}` };
    } catch (e: any) {
      return { content: `点击失败: ${e.message}`, isError: true };
    }
  },
};

const fillTool: Tool = {
  name: "chrome_fill",
  description: "往当前标签页的输入框/文本域填值(selector 定位)，会正确触发 input/change 事件。submit=true 则填完立即提交所在表单。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "输入框的 CSS 选择器" },
      value: { type: "string", description: "要填入的值" },
      submit: { type: "boolean", description: "填完是否提交表单/回车，默认 false" },
    },
    required: ["selector", "value"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const sel = String(input.selector);
      const val = String(input.value ?? "");
      const submit = !!input.submit;
      const js = `(function(){
        var el=document.querySelector(${JSON.stringify(sel)});
        if(!el) return 'NOT_FOUND';
        el.focus();
        var proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        var setter=Object.getOwnPropertyDescriptor(proto,'value');
        if(setter&&setter.set) setter.set.call(el,${JSON.stringify(val)}); else el.value=${JSON.stringify(val)};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        if(${submit}){
          if(el.form&&el.form.requestSubmit) el.form.requestSubmit();
          else if(el.form) el.form.submit();
          else el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));
        }
        return 'OK';
      })();`;
      const r = String(await evalInPage(js));
      if (r === "NOT_FOUND") return { content: `未找到输入框 ${sel}`, isError: true };
      return { content: `已填入 ${sel}${submit ? " 并提交" : ""}` };
    } catch (e: any) {
      return { content: `填写失败: ${e.message}`, isError: true };
    }
  },
};

const submitTool: Tool = {
  name: "chrome_submit",
  description: "提交表单：给 selector 则提交该元素所在(或匹配)的 form；不给则提交当前聚焦元素所在的 form(等价回车)。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: { selector: { type: "string", description: "form 或表单内元素的 CSS 选择器，可选" } },
  },
  async run(input): Promise<ToolResult> {
    try {
      const sel = input.selector ? String(input.selector) : "";
      const js = `(function(){
        var el=${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.activeElement"};
        if(!el) return 'NOT_FOUND';
        var form=el.tagName==='FORM'?el:el.form||el.closest('form');
        if(!form) return 'NO_FORM';
        if(form.requestSubmit) form.requestSubmit(); else form.submit();
        return 'OK';
      })();`;
      const r = String(await evalInPage(js));
      if (r === "NOT_FOUND") return { content: "未找到目标元素", isError: true };
      if (r === "NO_FORM") return { content: "该元素不在任何 form 内", isError: true };
      return { content: "已提交表单" };
    } catch (e: any) {
      return { content: `提交失败: ${e.message}`, isError: true };
    }
  },
};

const scrollTool: Tool = {
  name: "chrome_scroll",
  description: "滚动当前标签页。默认向下滚一屏；可指定像素 dy(正=下/负=上)、dx，或 to='top'|'bottom'，或 selector 滚到某元素。",
  readOnly: true, // 滚动无副作用
  inputSchema: {
    type: "object",
    properties: {
      dy: { type: "number", description: "垂直滚动像素(正下负上)，默认约一屏" },
      dx: { type: "number", description: "水平滚动像素，可选" },
      to: { type: "string", description: "'top' 或 'bottom'" },
      selector: { type: "string", description: "滚动到该元素，可选" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      let js: string;
      if (input.selector) {
        js = `(function(){var el=document.querySelector(${JSON.stringify(String(input.selector))});if(!el)return 'NOT_FOUND';el.scrollIntoView({block:'center'});return 'OK';})();`;
      } else if (input.to === "top") {
        js = `(window.scrollTo(0,0),'OK')`;
      } else if (input.to === "bottom") {
        js = `(window.scrollTo(0,document.body.scrollHeight),'OK')`;
      } else {
        const dy = input.dy != null ? Number(input.dy) : "Math.round(window.innerHeight*0.9)";
        const dx = input.dx != null ? Number(input.dx) : 0;
        js = `(window.scrollBy(${dx},${dy}),'OK')`;
      }
      const r = String(await evalInPage(js));
      if (r === "NOT_FOUND") return { content: "未找到该元素", isError: true };
      return { content: "已滚动" };
    } catch (e: any) {
      return { content: `滚动失败: ${e.message}`, isError: true };
    }
  },
};

const screenshotTool: Tool = {
  name: "chrome_screenshot",
  description: "对调试 Chrome 当前标签页截图并返回图片，供你直接看页面渲染效果(定位按钮/核对布局/确认结果)。full_page=true 截整页(否则可视区)。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { full_page: { type: "boolean", description: "是否截整页，默认 false(仅可视区)" } },
  },
  async run(input): Promise<ToolResult> {
    try {
      const { wsUrl } = await pickWs();
      const params: any = { format: "png", captureBeyondViewport: !!input.full_page };
      const r = await cdpSend(wsUrl, "Page.captureScreenshot", params, 30000);
      const data = r?.data;
      if (!data) return { content: "截图为空", isError: true };
      return { content: "已截图(见下方图片)", images: [`data:image/png;base64,${data}`] };
    } catch (e: any) {
      return { content: `截图失败: ${e.message}`, isError: true };
    }
  },
};

const evalTool: Tool = {
  name: "chrome_eval",
  description: "在当前标签页里执行任意 JavaScript 并返回结果(高级/兜底用；支持 await)。用于内置工具覆盖不到的取值或操作。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: { js: { type: "string", description: "要执行的 JS 表达式/IIFE" } },
    required: ["js"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const v = await evalInPage(String(input.js));
      const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      const out = (s ?? "undefined").toString();
      return { content: out.length > 12000 ? out.slice(0, 12000) + "\n…(已截断)" : out };
    } catch (e: any) {
      return { content: `执行失败: ${e.message}`, isError: true };
    }
  },
};

const closeTool: Tool = {
  name: "chrome_close",
  description: "关闭标签或退出调试 Chrome。给 tab_id/tab_index 关某个标签；quit=true 退出整个 Chrome。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      tab_id: { type: "string", description: "要关闭的标签 id" },
      tab_index: { type: "number", description: "要关闭的标签序号(1 基)" },
      quit: { type: "boolean", description: "退出整个 Chrome" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      if (input.quit) {
        spawn("osascript", ["-e", 'quit app "Google Chrome"'], { stdio: "ignore" }).unref();
        return { content: "已请求退出 Chrome" };
      }
      const pages = await listPages();
      let t: CdpTarget | undefined;
      if (input.tab_id) t = pages.find((p) => p.id === String(input.tab_id));
      else if (input.tab_index) t = pages[Number(input.tab_index) - 1];
      else t = pages.find((p) => p.id === state.selectedTargetId) || pages[0];
      if (!t) return { content: "未找到要关闭的标签", isError: true };
      await httpJson("/json/close/" + t.id);
      if (t.id === state.selectedTargetId) state.selectedTargetId = undefined;
      return { content: `已关闭标签：${t.title || t.url}` };
    } catch (e: any) {
      return { content: `关闭失败: ${e.message}`, isError: true };
    }
  },
};

export const CHROME_TOOLS: Tool[] = [
  launchTool,
  tabsTool,
  openTool,
  readTool,
  findTool,
  clickTool,
  fillTool,
  submitTool,
  scrollTool,
  screenshotTool,
  evalTool,
  closeTool,
];
