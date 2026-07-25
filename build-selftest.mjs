// 用 esbuild 以「和 electron.vite.config 主进程相同的条件」打包 embed 自测：
// cjs + alias onnxruntime-node→onnxruntime-web + external sharp/electron + .js→.ts 解析。
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const jsToTs = {
  name: "js-to-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.importer && args.path.startsWith(".")) {
        const base = resolve(dirname(args.importer), args.path);
        for (const ext of [".ts", ".tsx"]) {
          const cand = base.replace(/\.js$/, ext);
          if (existsSync(cand)) return { path: cand };
        }
      }
      return null;
    });
  },
};

await build({
  entryPoints: ["src/brain/embed-selftest.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "/tmp/mc-selftest.cjs",
  external: ["electron"],
  alias: { "onnxruntime-node": "onnxruntime-web", "sharp": new URL("./src/brain/sharp-stub.mjs", import.meta.url).pathname },
  define: { "import.meta.url": "__importMetaUrl" },
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  plugins: [jsToTs],
  logLevel: "warning",
});
console.log("✓ selftest bundled → /tmp/mc-selftest.cjs");
