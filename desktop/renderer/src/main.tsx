import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "highlight.js/styles/github.css";
import "./theme.css";
import "./baby/baby.css"; // 数字婴儿 VI(色/间距/圆角/动效标准) + 形象动画

createRoot(document.getElementById("root")!).render(<App />);
console.log("[boot] renderer mounted ok");
