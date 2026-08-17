#!/bin/bash
# 本机就地升级 minicc（macOS）：等旧版退出 → 备份 → ditto 新版 → ad-hoc 重签 → 去隔离 → 重新打开。
#
# 用法：先 `npx electron-vite build && npx electron-builder --mac dir --x64`，
# 然后在**独立会话**里跑本脚本（minicc 里跑 AI 助手时尤其重要，否则 app 一退脚本自己也被带走）：
#   node -e "require('child_process').spawn('/bin/bash',['scripts/upgrade-local-mac.sh'],{detached:true,stdio:'ignore'}).unref()"
# 然后 ⌘Q 退出 minicc，剩下的它自动做完并重新打开。
#
# ★ 血泪：备份**绝不能留在 /Applications/**（2026-08-17 栽过）。
#   minicc 是 ad-hoc 签名(无开发者证书)，macOS 的隐私授权(TCC)按「bundle id + 签名」记账；
#   /Applications 下同时存在两个 CFBundleIdentifier=com.minicc.app 的副本时，
#   LaunchServices/TCC 会把请求方认成那个 .bak 副本(弹窗上显示的就是 .bak 的名字)，
#   于是你点的"允许"记到陈旧条目上，每次访问「文稿」都重新弹窗，点几次都没用。
#   补救：把 .bak 挪出 /Applications → `lsregister -u 旧路径` + `lsregister -f 新路径`
#         → `tccutil reset SystemPolicyDocumentsFolder com.minicc.app` → 再允许一次即可长期生效。
set -u
SRC="${SRC:-$HOME/Documents/tanxun/git/minicc-desktop/release/mac/minicc.app}"
DST="/Applications/minicc.app"
BAKDIR="$HOME/.minicc/backups"                       # 备份放这儿,不放 /Applications
BAK="$BAKDIR/minicc.app.bak_$(date +%Y%m%d_%H%M%S)"
LOG="$HOME/.minicc/upgrade.log"
KEEP=3                                                # 只留最近 3 个备份(每个约 700MB)
WAIT=${WAIT:-28800}                                   # 等用户退出的秒数(默认 8 小时:挂上去等你哪会儿顺手退出)
PAT="^/Applications/minicc\.app/Contents/MacOS/minicc" # 只匹配正式安装路径

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
running() { pgrep -f "$PAT" > /dev/null; }

mkdir -p "$BAKDIR"
[ -d "$SRC" ] || { say "新版不存在：$SRC（先跑 electron-builder）"; exit 1; }

say "===== 等待 minicc 退出（最多 $((WAIT / 60)) 分钟）====="
for _ in $(seq 1 "$WAIT"); do running || break; sleep 1; done
if running; then say "超时：minicc 一直没退出，本次升级放弃（旧版原样没动）"; exit 1; fi
sleep 2 # 给它收尾落盘的时间

say "备份旧版 → $BAK"
mv "$DST" "$BAK" || { say "备份失败，放弃"; exit 1; }

say "拷贝新版（ditto；别用 cp -R，拷 Electron Framework 会 Operation not permitted）"
if ! ditto "$SRC" "$DST"; then
  say "ditto 失败 → 回滚旧版"
  rm -rf "$DST"; mv "$BAK" "$DST"; open -a "$DST"; exit 1
fi

say "ad-hoc 重签 + 去隔离"
codesign --force --deep --sign - "$DST" >> "$LOG" 2>&1
xattr -dr com.apple.quarantine "$DST" >> "$LOG" 2>&1

say "重新打开 minicc"
open -a "$DST"
sleep 8
if ! running; then
  say "新版没能起来 → 回滚旧版并打开"
  rm -rf "$DST"; mv "$BAK" "$DST"; open -a "$DST"; exit 1
fi

# 旧备份只留最近 KEEP 个
ls -1dt "$BAKDIR"/minicc.app.bak_* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  say "清理旧备份 $old"; rm -rf "$old"
done
say "升级完成（备份在 $BAK）"
