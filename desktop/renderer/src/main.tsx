import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "highlight.js/styles/github.css";
import "./theme.css";
import "./baby/baby.css"; // 数字婴儿 VI(色/间距/圆角/动效标准) + 形象动画

// 全局点击反馈：任何按钮 / 可点条目按下去都压一下 + 扩一圈波纹，让人确认"点到了"。
// 统一放这儿而不是逐个组件加：界面里按钮几百个，这样以后新加的按钮天生就有反馈。
// 只用 box-shadow 做效果——transform/filter 会给绝对定位的浮层造出新的包含块，把下拉/悬浮面板定位搞歪。
const TAPPABLE = [
  "button",
  "[role='button']",
  ".session-item",
  ".search-row",
  ".ctx-item",
  ".agi-item-name",
  ".agi-add",
  ".agi-head",
  ".acct-menu-item",
  ".mq-item",
  ".suggest-bar",
  ".by-card-head",
  ".ask-toast",
  ".trash-row",
  ".tp-row",
].join(",");
document.addEventListener(
  "pointerdown",
  (e) => {
    const el = (e.target as Element | null)?.closest?.(TAPPABLE) as HTMLElement | null;
    if (!el) return;
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
    el.classList.remove("tap-pulse");
    void el.offsetWidth; // 强制回流，连点也能重放动画
    el.classList.add("tap-pulse");
    const done = () => el.classList.remove("tap-pulse");
    el.addEventListener("animationend", done, { once: true });
    window.setTimeout(done, 500); // 兜底：动画被系统禁用/元素被重渲染时也把类清掉
  },
  true, // 捕获阶段：组件自己 stopPropagation 也照样有反馈
);

createRoot(document.getElementById("root")!).render(<App />);
console.log("[boot] renderer mounted ok");
