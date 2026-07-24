// 用 sharp 把 build/icon.png 生成多尺寸内嵌 PNG 的 .ico，
// 绕开 electron-builder 自带 WASM 图标转换工具(本机内存分配失败)。
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "build/icon.png");
const out = resolve(root, "build/icon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngs = await Promise.all(
  sizes.map((s) => sharp(src).resize(s, s, { fit: "cover" }).png().toBuffer()),
);

// ICO 文件结构：6 字节头 + N×16 字节目录项 + 各 PNG 数据
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type=1 icon
header.writeUInt16LE(count, 4);

const dir = Buffer.alloc(count * 16);
let offset = 6 + count * 16;
pngs.forEach((buf, i) => {
  const s = sizes[i];
  const b = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, b + 0); // width (0 表示 256)
  dir.writeUInt8(s >= 256 ? 0 : s, b + 1); // height
  dir.writeUInt8(0, b + 2); // palette
  dir.writeUInt8(0, b + 3); // reserved
  dir.writeUInt16LE(1, b + 4); // color planes
  dir.writeUInt16LE(32, b + 6); // bpp
  dir.writeUInt32LE(buf.length, b + 8); // data size
  dir.writeUInt32LE(offset, b + 12); // data offset
  offset += buf.length;
});

writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
console.log("wrote", out, "sizes:", sizes.join(","));
