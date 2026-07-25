// electron-vite 构建配置：main / preload / renderer 三段。
// 关键：core(src/) 用 NodeNext 风格 import('./x.js') 指向 x.ts，
// 给 rollup 装一个解析插件把 .js 落到实际的 .ts/.tsx。
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

const jsToTs = {
  name: "js-to-ts-resolve",
  resolveId(source: string, importer: string | undefined) {
    if (importer && source.startsWith(".") && source.endsWith(".js")) {
      const base = resolve(dirname(importer), source);
      for (const ext of [".ts", ".tsx"]) {
        const cand = base.replace(/\.js$/, ext);
        if (existsSync(cand)) return cand;
      }
    }
    return null;
  },
};

export default defineConfig({
  main: {
    // externalizeDepsPlugin: 把 node_modules 依赖 external（运行时 require），不 bundle；
    // external:["electron"]: electron 在 devDeps 不被上面处理，必须显式 external，
    // 否则 npm electron 包的 stub(spawnSync install.js)被打进主进程→启动即 fork bomb。
    // exclude: 把 transformers + onnxruntime-web 一起 bundle 进主进程（不 external），
    // 这样下面的 alias 才能把 onnxruntime-node 换成 onnxruntime-web。
    // 原因：onnxruntime-node 原生模块与 Electron 的 Node ABI 不兼容(加载即 SIGTRAP)，
    // 改用 onnxruntime-web(wasm)在 Electron 里稳定运行。系统 node(CLI/测试)不受影响。
    plugins: [externalizeDepsPlugin({ exclude: ["@xenova/transformers", "onnxruntime-web"] }), jsToTs],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: resolve(root, "desktop/main/index.ts"),
        external: ["electron"],
      },
    },
    resolve: {
      // transformers 静态 import 'onnxruntime-node'，在 Electron 会崩；alias 成 wasm 版
      alias: { "onnxruntime-node": "onnxruntime-web" },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: resolve(root, "desktop/preload/index.ts"),
        external: ["electron"],
        // Electron preload(sandbox) 必须是 CommonJS；package type:module 下
        // .js 会被当 ESM，故强制 cjs + .cjs 后缀，否则 preload 加载失败→window.minicc 丢失
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(root, "desktop/renderer"),
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: resolve(root, "desktop/renderer/index.html") },
    },
  },
});
