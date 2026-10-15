# 运行、备份与恢复

本文面向维护人员。日常操作见[使用指南](USER_GUIDE.md)，初次环境见[安装指南](INSTALLATION.md)，公网切换见[部署指南](DEPLOYMENT.md)。所有示例路径应替换为自己的独立位置。

## 检查与启动

```sh
npm run doctor:workspace
npm run open:workspace
```

已有配置时沿用原资料目录、项目范围和连接地址。重复打开刷新原入口，不抢占端口。监督窗口只管理自己创建的网页进程；其他工具与活动执行环境不在其控制范围。

刷新一次性连接：

```sh
export SYNPLEX_WORKSPACE_DATA_DIR=/absolute/path/to/private-workspace
npm run connect:workspace
```

入口保存到资料目录的 `打开Synplex.html`，五分钟有效。正式连接文件与 token 需要仅本人可读。浏览器无法打开本地 HTML 时，在相同工作台页面填入新一次性码，不填正式 token。

## 自有执行引擎

源码与依赖位于 `vendor/agenthub/backend`。依照安装指南创建独立 Python 环境和私有数据库、队列，再运行：

```sh
/absolute/path/to/python-env/bin/python integrations/agenthub/engine_runtime.py check --root /absolute/path/to/engine-data
/absolute/path/to/python-env/bin/python integrations/agenthub/engine_runtime.py run --root /absolute/path/to/engine-data
```

模型连接以私有 JSON 档案提供，例如：

```json
{
  "provider": "deepseek",
  "models": ["deepseek-flash"],
  "maxTokens": 4096,
  "tokenFile": "/absolute/private/path/provider-key"
}
```

档案和密钥文件权限均为 `600`。使用当前已评估的型号，不将模型目录条目视为账号授权。配置入口仅适用于尚未启用模型的独立引擎：

```sh
/absolute/path/to/python-env/bin/python integrations/agenthub/engine_runtime.py configure-provider --root /absolute/path/to/engine-data --profile /absolute/private/path/provider.json
```

配置不探测余额、不请求模型。实际开工前检查自己的供应商额度。不要从其他 Agent 的环境获取凭据。

## 网页执行连接

数据目录的 `executors.json` 由管理员明确创建，权限 `600`，准确字段见 `services/workspace/executors.mjs`。自有引擎字段包括 `endpoint`、`tokenFile`、`workflowId`；受托 Codex 使用独立 `home`、明确型号和工具配置。不要复用活动宿主 HOME。

任务先保存完整说明，再由用户明确开始。等待回答、操作确认、停止、结果未知与人工验收分别处理。接收回执丢失时按原提交身份查询；结果补写失败只补记录，不能重跑工具。

## 联合启动

引擎与网页各自安装、连接核对后：

```sh
export SYNPLEX_WORKSPACE_DATA_DIR=/absolute/path/to/private-workspace
node scripts/runtime/open.mjs configure-product /absolute/path/to/engine-data /absolute/path/to/python-env/bin/python
```

此操作只保存已核对的启动设置。此后使用生成的启动器，按数据库、队列、执行环境和网页顺序启动自己的服务。恢复停用的执行器不能通过联合启动设置自动启用。

## 工作台备份

正常关闭这份工作台后：

```sh
npm run backup:workspace -- /absolute/path/to/workspace /absolute/path/to/new-backup
npm run restore:workspace -- /absolute/path/to/new-backup /absolute/path/to/new-restored-workspace 5200
```

备份包含 SQLite、原件、成果、执行回执与本目录配置；核对文件指纹、数据库关系及占用状态。只恢复到全新目录，原目录保留。恢复的执行配置默认停用，未知任务与历史不被清空。

以上工作台备份不自动包含外部引擎数据库、队列与系统凭据。联合产品备份使用 `integrations/agenthub/engine_recovery.py` 的对应命令；先用 `--help` 查看当前参数和明确的工作台/引擎目录。备份含私人资料，按原数据等级保管。

## 首次闲置联合接管

联合快照恢复后生成“核对并启用副本”入口。它要求原实例与副本停止、快照后原资料未变化、没有未知或未完成任务、没有积压消息，且两边身份、文件、队列和配置一致。输入“接续”才开始转移运行权。

接管意图持久化后，原目录被停用；中断只继续同一意图，不新建任务。原目录仍是接管见证，必须原位保留，不是可清理缓存。跨版本、未完成任务和远端身份变化的边界见[当前使用范围](LIMITATIONS.md)。

## 程序升级与回退

`scripts/runtime/upgrade.mjs` 管理程序与资料分开的本地发行，先检查文件指纹、平台和数据能力声明，再用停用副本预检后切换程序。它保留最新业务数据，不把回退代码变成回退账本。恢复控制记录要求相应语义能力，不理解的新旧包均不能强行运行。

```sh
node scripts/runtime/upgrade.mjs init /absolute/path/to/new-installation /absolute/path/to/release /absolute/path/to/workspace
```

升级、回退和联合引擎迁移是不同操作；不能删除数据能力标记来让旧程序启动。公网升级使用部署指南的服务器备份和路由回退流程。

## 诊断

请求问题编号对应私有资料目录 `diagnostics/requests.jsonl` 中的 `traceId`。日志最多两个各 1MiB 片段，只含固定操作名、状态、耗时和散列身份，不记录正文、密钥或完整路径。分享前仍需脱敏。

页面任务状态来自最近保存记录，不把历史文字当作仍在运行。健康接口仅证明服务响应。模型、执行器、原文件、业务结果分别核对。

## 发行与复现

```sh
npm run build:release -- /absolute/path/to/new-release --engine-source vendor/agenthub/backend
```

生成源码和内容清单；加 `--bundle-dependencies` 可打包同平台已安装依赖。程序文件与运行数据分开。复制包改变后会被指纹检查拒绝；不要把私人数据库、模型密钥或个人连接包放进发行。

## 结构与可靠性测量

```sh
npm run check
node scripts/quality/maintainability.mjs report /absolute/path/to/new-report.json
```

静态门核对语法、模块符号、循环和复杂度预算；运行时回归覆盖真实 SQLite/HTTP 与故障恢复。可靠性计算脚本只读取已有测量数据，不把软件断言数换算成业务成功率。长期观察必须绑定准确程序版本，不能把旧版本观察算作新版本成绩。
