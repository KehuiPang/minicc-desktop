// computer_* 工具：像人一样操作整台电脑(任何软件)。
// 截屏理解 + 鼠标 + 键盘。依赖 macOS 自带/已装命令：
//   screencapture(截屏, 系统自带)、sips(缩放, 系统自带)、cliclick(鼠标/点击)、
//   osascript(键盘/组合键)、python3+pyautogui(取逻辑分辨率/滚动)。
// 需要系统「屏幕录制」「辅助功能」授权(首次会弹窗)，否则截屏发黑/点击无效。
//
// 坐标一致性(关键)：Retina 屏 screencapture 出的是物理像素(2x)，而 cliclick 用逻辑点(1x)。
// 我们把截屏缩放到「逻辑分辨率」再返回，并记录缩放比；点击时把模型给的图上坐标按比例换算回逻辑点，
// 保证「模型在返回图上看到哪、点哪」与实际一致。
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "../types.js";

const pexec = promisify(exec);
const PY = "/usr/local/bin/python3"; // 装了 pyautogui 的解释器(见记忆)

// 上一张返回给模型的截屏的坐标映射：逻辑点 = 图上像素 * scale
const shot: { logicalW: number; logicalH: number; imgW: number; imgH: number } = {
  logicalW: 0,
  logicalH: 0,
  imgW: 0,
  imgH: 0,
};

async function logicalSize(): Promise<{ w: number; h: number }> {
  try {
    const { stdout } = await pexec(`${PY} -c "import pyautogui,sys;s=pyautogui.size();sys.stdout.write('%d %d'%(s[0],s[1]))"`, {
      timeout: 15000,
    });
    const [w, h] = stdout.trim().split(/\s+/).map(Number);
    if (w && h) return { w, h };
  } catch {}
  return { w: 0, h: 0 };
}

function sh(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---- 截屏 ----
const screenshotTool: Tool = {
  name: "computer_screenshot",
  description:
    "对整个电脑屏幕截图并返回图片，让你直接看到屏幕上正在显示什么(任何 app 都行)。之后用 computer_click/computer_type/computer_key 按你在图上看到的位置操作。图片坐标即点击坐标(已按逻辑分辨率对齐)。多屏可用 display 指定(1=主屏)。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { display: { type: "number", description: "第几个显示器(1=主屏)，默认主屏" } },
  },
  async run(input): Promise<ToolResult> {
    const tmp = join(tmpdir(), `minicc-shot-${Date.now()}.png`);
    try {
      const disp = input.display ? `-D ${Number(input.display)}` : "";
      await pexec(`/usr/sbin/screencapture -x ${disp} ${sh(tmp)}`, { timeout: 20000 });
      // 物理像素尺寸
      const { stdout: dim } = await pexec(`sips -g pixelWidth -g pixelHeight ${sh(tmp)}`, { timeout: 15000 });
      const pw = Number(/pixelWidth:\s*(\d+)/.exec(dim)?.[1] || 0);
      const ph = Number(/pixelHeight:\s*(\d+)/.exec(dim)?.[1] || 0);
      const lg = await logicalSize();
      // 目标图像尺寸：优先缩放到逻辑分辨率；若逻辑长边仍 >1568，再等比缩到 1568(省 token)
      let targetW = lg.w || pw;
      let targetH = lg.h || ph;
      const long = Math.max(targetW, targetH);
      if (long > 1568) {
        const k = 1568 / long;
        targetW = Math.round(targetW * k);
        targetH = Math.round(targetH * k);
      }
      if (targetW && targetH && (targetW !== pw || targetH !== ph)) {
        await pexec(`sips -z ${targetH} ${targetW} ${sh(tmp)} --out ${sh(tmp)}`, { timeout: 15000 });
      }
      const buf = await fs.readFile(tmp);
      shot.logicalW = lg.w || targetW;
      shot.logicalH = lg.h || targetH;
      shot.imgW = targetW;
      shot.imgH = targetH;
      const note = `屏幕逻辑分辨率约 ${shot.logicalW}x${shot.logicalH}；返回图 ${targetW}x${targetH}(坐标即点击坐标)。`;
      return { content: `已截屏。${note}`, images: [`data:image/png;base64,${buf.toString("base64")}`] };
    } catch (e: any) {
      return {
        content: `截屏失败: ${e.message}。若持续失败，多半是没授「屏幕录制」权限(系统设置→隐私与安全性→屏幕录制，勾选 minicc/终端后重启 app)。`,
        isError: true,
      };
    } finally {
      fs.unlink(tmp).catch(() => {});
    }
  },
};

// 图上坐标 → 逻辑点
function toLogical(x: number, y: number): { x: number; y: number } {
  if (shot.imgW && shot.logicalW) {
    return { x: Math.round((x * shot.logicalW) / shot.imgW), y: Math.round((y * shot.logicalH) / shot.imgH) };
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// ---- 鼠标点击/移动 ----
const clickTool: Tool = {
  name: "computer_click",
  description:
    "在屏幕坐标 (x,y) 点击鼠标。坐标用你在最近一次 computer_screenshot 返回图上看到的像素位置(会自动换算)。button 可选 left/right，double=true 双击。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      button: { type: "string", description: "left(默认)/right" },
      double: { type: "boolean", description: "是否双击" },
    },
    required: ["x", "y"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const { x, y } = toLogical(Number(input.x), Number(input.y));
      const cmd = input.double ? "dc" : input.button === "right" ? "rc" : "c";
      await pexec(`cliclick ${cmd}:${x},${y}`, { timeout: 10000 });
      return { content: `已${input.double ? "双击" : input.button === "right" ? "右键点击" : "点击"} (${x},${y})` };
    } catch (e: any) {
      return { content: `点击失败: ${e.message}(可能缺「辅助功能」授权)`, isError: true };
    }
  },
};

const moveTool: Tool = {
  name: "computer_move",
  description: "把鼠标移动到屏幕坐标 (x,y)(不点击)。坐标同 computer_screenshot 返回图。",
  readOnly: false,
  inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
  async run(input): Promise<ToolResult> {
    try {
      const { x, y } = toLogical(Number(input.x), Number(input.y));
      await pexec(`cliclick m:${x},${y}`, { timeout: 10000 });
      return { content: `鼠标已移动到 (${x},${y})` };
    } catch (e: any) {
      return { content: `移动失败: ${e.message}`, isError: true };
    }
  },
};

const dragTool: Tool = {
  name: "computer_drag",
  description: "从 (x1,y1) 按住拖动到 (x2,y2) 再松开(拖拽/框选/滑动)。坐标同 computer_screenshot 返回图。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      x1: { type: "number" },
      y1: { type: "number" },
      x2: { type: "number" },
      y2: { type: "number" },
    },
    required: ["x1", "y1", "x2", "y2"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const a = toLogical(Number(input.x1), Number(input.y1));
      const b = toLogical(Number(input.x2), Number(input.y2));
      await pexec(`cliclick dd:${a.x},${a.y} du:${b.x},${b.y}`, { timeout: 15000 });
      return { content: `已从 (${a.x},${a.y}) 拖到 (${b.x},${b.y})` };
    } catch (e: any) {
      return { content: `拖拽失败: ${e.message}`, isError: true };
    }
  },
};

// ---- 键盘：输入文本 ----
const typeTool: Tool = {
  name: "computer_type",
  description:
    "在当前聚焦的输入位置键入文本(先用 computer_click 点中输入框)。含中文/非 ASCII 时自动走剪贴板粘贴以保证正确。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      paste: { type: "boolean", description: "强制走剪贴板粘贴(默认按内容自动判断)" },
    },
    required: ["text"],
  },
  async run(input): Promise<ToolResult> {
    const text = String(input.text ?? "");
    const needPaste = input.paste === true || /[^\x00-\x7F]/.test(text); // 非 ASCII → 粘贴更可靠
    try {
      if (needPaste) {
        // 存旧剪贴板 → 写入 → cmd+v 粘贴 → 恢复
        let old = "";
        try {
          old = (await pexec("pbpaste", { timeout: 8000 })).stdout;
        } catch {}
        const child = exec("pbcopy");
        child.stdin?.end(text);
        await new Promise((r) => setTimeout(r, 120));
        await pexec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 10000 });
        await new Promise((r) => setTimeout(r, 120));
        if (old) {
          const c2 = exec("pbcopy");
          c2.stdin?.end(old);
        }
        return { content: `已粘贴文本(${text.length} 字)` };
      }
      await pexec(`cliclick -w 5 t:${sh(text)}`, { timeout: 20000 });
      return { content: `已输入文本(${text.length} 字)` };
    } catch (e: any) {
      return { content: `输入失败: ${e.message}(可能缺「辅助功能」授权)`, isError: true };
    }
  },
};

// ---- 键盘：按键/组合键 ----
// 特殊键名 → osascript key code
const KEYCODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
const MODS: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  ctrl: "control down",
  control: "control down",
  alt: "option down",
  option: "option down",
  opt: "option down",
  shift: "shift down",
  fn: "function down",
};

const keyTool: Tool = {
  name: "computer_key",
  description:
    "按下一个按键或组合键。例：'return'、'esc'、'down'、'cmd+a'(全选)、'cmd+c'、'cmd+shift+4'、'ctrl+space'。用于确认/复制/切换/快捷键等。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: { keys: { type: "string", description: "如 'return' / 'cmd+a' / 'ctrl+shift+t'" } },
    required: ["keys"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const raw = String(input.keys || "").trim();
      if (!raw) return { content: "keys 为空", isError: true };
      const parts = raw.split("+").map((p) => p.trim().toLowerCase());
      const mods = parts.filter((p) => MODS[p]).map((p) => MODS[p]);
      const keyPart = parts.find((p) => !MODS[p]) || "";
      const using = mods.length ? ` using {${mods.join(", ")}}` : "";
      let script: string;
      if (KEYCODES[keyPart] != null) {
        script = `tell application "System Events" to key code ${KEYCODES[keyPart]}${using}`;
      } else if (keyPart.length === 1) {
        script = `tell application "System Events" to keystroke ${JSON.stringify(keyPart)}${using}`;
      } else if (!keyPart && mods.length) {
        return { content: "只给了修饰键，缺主键", isError: true };
      } else {
        return { content: `不认识的按键: ${keyPart}`, isError: true };
      }
      await pexec(`osascript -e ${sh(script)}`, { timeout: 10000 });
      return { content: `已按键: ${raw}` };
    } catch (e: any) {
      return { content: `按键失败: ${e.message}(可能缺「辅助功能」授权)`, isError: true };
    }
  },
};

// ---- 滚动 ----
const scrollTool: Tool = {
  name: "computer_scroll",
  description: "在当前鼠标处(或先移动到 x,y)滚动。amount 正=向上、负=向下(单位:滚动格)。用于翻长页面/列表。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "滚动量：正上负下，默认 -5(向下)" },
      x: { type: "number", description: "先把鼠标移到此处再滚，可选" },
      y: { type: "number", description: "先把鼠标移到此处再滚，可选" },
    },
  },
  async run(input): Promise<ToolResult> {
    try {
      const amount = input.amount != null ? Number(input.amount) : -5;
      let movepy = "";
      if (input.x != null && input.y != null) {
        const { x, y } = toLogical(Number(input.x), Number(input.y));
        movepy = `pyautogui.moveTo(${x},${y});`;
      }
      await pexec(`${PY} -c "import pyautogui;${movepy}pyautogui.scroll(${amount})"`, { timeout: 15000 });
      return { content: `已滚动(${amount})` };
    } catch (e: any) {
      return { content: `滚动失败: ${e.message}`, isError: true };
    }
  },
};

export const COMPUTER_TOOLS: Tool[] = [
  screenshotTool,
  clickTool,
  moveTool,
  dragTool,
  typeTool,
  keyTool,
  scrollTool,
];
