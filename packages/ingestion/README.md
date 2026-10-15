# 确定性资料导入：阶段交付

多格式适配：`documents.mjs` 调度一次性隔离进程，`document-parsers.mjs`由冻结Weave解析器适配，原树不变。PDF、DOCX、DOC/RTF（Mac）、ODT、XLS/XLSX/XLSM和PPTX保留原二进制文件；读取上限20MiB、文字100万字符、30秒及192MiB JS堆限制。Mac使用系统网络/写入禁止，Node文件读取范围仅为解析代码和本项目依赖；进程不继承凭据。非Mac要求Node25以上的网络权限机制，低版本保原件并给转换提示。不执行宏、不重算公式，表格缓存值与已有公式并列。

二进制提取只建立“整份原件→文字投影”来源：一个原件范围的block，`partial`且coveredBytes=0，整份文件作为未证明完整读取的范围。引用UTF16区间与quoteHash严格指向已保存的提取文字，绝不假称压缩字节的精确位置。图片、排版、批注、备注可能缺失；扫描或空文档保存原件并返回unsupported，无假引用。资料页提供文字预览和按真实格式下载原件。

依赖固定版本与锁保存在本树；fflate0.8.3、Ajv8.20.0采用安全补丁。Mammoth1.13.0的CLI依赖存在sprintf-js DoS告警，当前extractRawText调用不导入CLI/argparse；隔离与限时减少暴露但不证明不存在漏洞。依赖审查与原源码SHA见本机`.runtime/implementation-baseline/document-dependency-review.json`。不运行依赖安装脚本，不写旧Weave依赖。

`importSource(repo,input,meta)` 使用冻结的 ScopedRepository，仅处理显式提供的字节，不读取私人会话、路径或活动宿主，不启动执行、不调用模型。输入按 repository.d.ts；额外 role、permission、reviewStatus 等字段拒绝。bytes、metadata、MutationMeta 在第一次 await 前复制。来源标签与 importOrigin 不赋予权限，读写由真实 scoped repository 校验。

当前支持 `text/plain` / `text/markdown`、formatVersion=`1`、严格 UTF-8。sourceSystem 仅允许 `user-text`、`user-markdown`、`weave-explicit-export`、`synplex-explicit-export`、`isolated-test`；名称表示显式材料入口，不证明原生宿主兼容性。未知来源、版本与 NDJSON 产生 unsupported 解析版及字节缺口，原件保留。NDJSON 暂未开放：冻结接口没有 occurrence 到 block 子集的绑定，现有服务检索读取 occurrence 所在整个 parsed revision，无法可靠归属逐条消息。保留 `synplex.events/1` 常量不表示支持该格式。

保留 BOM、CRLF、emoji、末尾与原始标点。Markdown 保留完整段落、表格、代码围栏与 display-math 区段，不执行原文指令。超长逻辑区段完整保存，候选引用拆为至多8192个 UTF-16单元，不切断代理对，提示结合整个区段。原始范围为字节，引用范围为UTF-16 code units，不可混用。无效、过长、代理码点、越界与截断 UTF-8 形成精确字节缺口，有效连续区段继续保留。coverage 只度量解析，不证明语义或业务成功。normalizedTextHash 使用有序 block.text 数组的 canonical JSON SHA256；blockId 包含原件指纹、parser、格式/版本、字节范围及正文。

Blob与事件分开：同内容、格式与范围复用 source；不同 eventId 保留独立 occurrence。重复事件的出处或内容改变交服务隔离为冲突，旧证据和已接收新原件均保留。候选按原文字面规则标记 failure / decision / lesson，其余 unknown；全部 pending、有条件、无推断 supersedes、不标 fact。没有经过验证的作者身份，统一 historical_tool_text，不建立 direct_tool_receipt 或 independent_check。

Blob子请求使用根 requestId，首写遵守传入 revision。解析子请求以 scope 与完整 parsed 输入生成稳定标识，防止换上传请求重复递增同一解析版的状态；occurrence子请求保留每次导入根标识。候选子请求由 scope/occurrence/parser/rule/chunkHash 确定，每个标识至多128字符。后续读当前状态续接，服务逐写检查并发、权限与幂等。stale_context、撤权或不明失败立即停止，不自动绕过、吞错或启动执行。

检查点包含 scope/source/occurrence/chunk、parser/rule、prompt=null/model=null、permissionRevision/stateRevision，费用明确 no_model_call、0 tokens、0 USD。重启先重取稳定候选回执，再复用其历史状态与当前权限相符的成功检查点；缺检查点只补记，缺区段继续处理。历史回执用于防止重新提取，不覆盖人工拒绝，不代替最新任务背景校验。单独调用的 ImportResponse.operationId 是 occurrence 写回执；服务 worker 替换为接受上传的 operationId，并原子保存不可变 ImportResultSnapshot。

`adapters/weave/index.mjs` 仅接收 sourceSystem=`weave-explicit-export`、importOrigin=`user_upload` 的明确材料，不发现或监听私有数据库。`packages/context/repository-read.mjs` 仅为读取辅助函数：检查范围、分页循环、状态、结束前权限，证据最多1000条且如实标 partial，不构成 prepareContext。完整背景包、主线构建、token预算、experience治理、界面迁移、DSH宿主和真实宿主格式未完成。未做模型语义提取、真实宿主验收、吞吐或收益实验。

免费本地验证：

```sh
node --test --test-reporter=tap test/ingestion/*.test.mjs test/context/*.test.mjs
node --test --test-reporter=tap
```

使用锁定依赖、真实 WorkspaceRepository/ScopedRepository 与隔离 SQLite，覆盖原件/引用、逻辑区段、unsupported/partial、事件去重与冲突、重放与重启、中断续接、撤权、人工拒绝保留、Weave守卫、service worker不可变快照和分页边界。CLI测试使用动态空闲端口和临时数据目录，不改活动宿主或生产监听。完整回归的实际结果及整合阻塞以 DSH 协作意见的最新阶段回执为准。
