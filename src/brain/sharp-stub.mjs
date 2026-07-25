// 文本 embedding 不需要图像处理；stub 掉 sharp，避免其原生/依赖在打包环境的加载问题。
// transformers 只在处理图像时才真正调用 sharp(...)，文本流程只 import 不调用。
function sharpStub() { throw new Error("sharp is stubbed (text-only embedding)"); }
sharpStub.default = sharpStub;
export default sharpStub;
