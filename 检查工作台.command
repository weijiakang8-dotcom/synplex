#!/bin/zsh
cd -- "${0:A:h}" || exit 1
node scripts/runtime/open.mjs --check
synplexStatus=$?
read 'reply?按回车关闭。'
exit "$synplexStatus"
