# 接口与扩展协议

协议版本：`synplex.workspace/1.0.0`。正式契约位于 `packages/contracts/`；开发者应以 JSON Schema 与 `services/workspace/service.mjs` 导出的工具定义为准，不根据说明文字猜参数。

## 认证

宿主 HTTP 请求使用 `Authorization: Bearer ...`，凭据保存在本机私有文件。MCP 桥按连接文件读取，不接受原文中的授权声明。网页使用一次性 `ui_pair` 和 HttpOnly、SameSite=Strict 的短时会话。正式凭据不能写入 URL、源码、公开扩展或网页资源。

## 六个宿主工具

| 工具 | 用途 |
|---|---|
| `get_project_state` | 读取当前授权项目的状态 |
| `find_evidence` | 查找有原文位置的依据 |
| `prepare_task` | 冻结目标、约束、资料与验收要求 |
| `record_result` | 保存真实结果、原回执和已知用量 |
| `propose_lesson` | 提出附来源和适用条件的经验候选 |
| `get_operation` | 核对原操作回执 |

HTTP 使用 `POST /api/v1/{工具名}`；stdio MCP 使用同一组 Schema。`scope` 的项目、版本和分支必须准确，`null` 不代表通配符。

## 网页入口

`ui_bootstrap`、`ui_history` 提供授权状态和能力标记；导入使用 `import_source` 的 multipart 请求。作者治理、任务、执行、版本、文件和费用入口分别由 `http.mjs`、`read-routes.mjs`、`service.mjs` 及相关服务实现。

界面按服务返回的能力标记显示入口。使用同一 `requestId` 核对原提交；已有请求的内容改变时返回冲突，不能换标识强行重发未知操作。

## 错误

错误包含 `code`、`message`、`nextAction`、`retry` 与可用的操作身份。`scope_denied` 不可通过改参数扩大范围；`stale_context` 需要重新核对背景；结果未知时沿原操作查询；不支持的格式保留原件并给出转换出口。

健康接口只表明服务可响应，不证明任务质量、模型连接或费用收益。

## 对话与模型连接

`ui_models`、`ui_save_model`、`ui_change_model`、`ui_discover_models`、`ui_probe_model` 仅供具备准确项目权限的网页身份使用。发现型号可以使用未保存的 `endpoint` 与 `secret` 查询 `/models`；不保存秘密、不生成回复，也可以沿用已保存连接的 `selection`。型号能力仍需另外核对。

`ui_chat_create/list/history/send/events/lookup/stop/review` 使用持久会话、客户端请求身份与事件序号。相同请求读取原回执；unknown 先核对，不能自动重发。`prepare_task.conversationId` 仅引用本人当前项目的对话，服务端生成冻结参考，客户端不能提供伪造消息副本。

`/internal/model/v1` 是本机执行后台的任务专属模型转接，仅接受短权限凭据，绑定原执行和尝试。真实服务商密钥留在工作台加密库，不交给引擎。相同请求读取已保存原回复；未知结果阻止再次提交。`ui_review_model_calls` 仅在原任务终态、原用户核对后解除占用，不重发或将费用填零。


### 笔记库资料

`POST /api/v1/ui_obsidian_notes`：请求仅含`protocolVersion`与精确`scope`，需要当前UI会话和项目读取权限。返回`items`（笔记库名、相对位置、原件身份/指纹、导入操作状态和锁定状态）及`complete`。不返回本机绝对路径，最多读取最近1000次笔记导入。

笔记上传复用`import_source`：`sourceSystem=obsidian-markdown`、`format=text/markdown`、`formatVersion=1`，`sessionId`为JSON编码的`{vault,path}`，`path`仅允许库内普通`.md`相对位置。精确原文件上传，不拼接说明或改写链接；原件上限2MiB。相同文件重试必须复用原requestId与元数据。服务端拒绝用变更内容替换同位置已锁定资料。
