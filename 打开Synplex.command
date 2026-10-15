#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print '缺少运行环境，请由维护人员安装 Node.js 22 或更新版本。'
  read 'reply?按回车关闭。'
  exit 1
fi
node scripts/runtime/open.mjs
synplexStatus=$?
if [[ $synplexStatus -ne 0 ]]; then read 'reply?请根据上方提示处理，按回车关闭。'; fi
exit "$synplexStatus"
