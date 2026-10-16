<p align="center"><img src="public/logo-mark.png" width="80" alt="Synplex"></p>
<h1 align="center">Synplex</h1>
<p align="center"><strong>把模糊问题变成有依据的结构化系统。</strong></p>
<p align="center">一个能记住用户项目经历、协同 AI 执行并核对成果的工作台。</p>
<p align="center"><a href="https://synplex.xyz">网站</a> · <a href="docs/INSTALLATION.md">开始使用</a> · <a href="docs/USER_GUIDE.md">使用指南</a> · <a href="docs/EXTENSIONS.md">连接 Codex / DeepSeek Harness</a> · <a href="https://github.com/weijiakang8-dotcom/synplex/issues">反馈</a></p>

---

## 做过的项目，成为下一次的起点

隔了一段时间，或者换了一个 AI 工具，最难接上的往往不是代码，而是：**现在做到哪里？为什么换过方案？哪些办法已经失败？接下来要交付什么？**

Synplex 把资料、决定、任务和成果放进同一个项目。重要记录有出处，修改有前后版本，AI 开工前拿到明确目标与相关背景，完成后留下可以查看、下载和核对的交付。

## 你可以用它做什么

| 你要做的事 | Synplex 帮你完成 |
|---|---|
| 账号登录 | 登录名或邮箱登录、邮箱验证码找回密码；每个账号独立保存项目、资料与模型连接 |
| 连续聊天 | 在任务里切换对话，使用项目背景、自己选模型，保留消息与来源 |
| 连接自己的模型 | 填地址与密钥后获取可用型号；个人连接和内置模型分开 |
| 换工具继续项目 | 从已确认记录和原文准备完整工作说明，交给当前使用的工具 |
| 整理零散资料 | 导入文字、文档和会话；从 Obsidian 勾选笔记，保留原件和双链，按分类与标签查找 |
| 记住重要转折 | 回看修改原因、处理经过和当前结论；把有出处的变化带入下一次任务 |
| 把任务拆清楚 | 明确目标、限制、步骤依赖和验收条件；前一步变化时提醒重新核对 |
| 执行并交付 | 配置执行工具后，由你明确开始；查看进度、补充回答、确认操作和下载成果 |
| 修改已有成果 | 保留前版文件与原要求，提出修改，比较版本，再核对是否达到目标 |
| 看懂用量 | 分开呈现预计费用、执行记录和已知用量；保留失败与返工记录 |
| 整理项目经历 | 选择已确认记录，预览并导出带来源的项目介绍 |

## 两种用法，同一份项目依据

**网页版**：在自己的电脑运行工作台，管理项目、资料、记录、任务和成果。数据保存在自己选择的资料目录。

**扩展版**：把项目依据接到 Codex 或 DeepSeek Harness，让熟悉的执行工具继续工作。扩展提供项目状态、查找依据、准备任务、记录结果、提炼经验和查看回执六个工具，不在背后另起一个 Agent。

两种用法互相补齐：你可以用工作台梳理项目，再用擅长执行的工具推进，把结果带回项目。

## 快速开始

需要 **Node.js 26**、npm、Git 和 `lsof`。macOS 是主要验收平台；独立执行引擎另需 Python 3.11、PostgreSQL、Valkey 与模型连接。仅整理资料和接续项目不需要模型密钥。

```sh
git clone https://github.com/weijiakang8-dotcom/synplex.git
cd synplex
npm ci --ignore-scripts
npm run open:workspace
```

在 Mac 也可以双击项目内的 **打开Synplex.command**。初次使用新资料目录，不会导入作者的私人数据或复制任何密钥。入口和详细依赖说明见[安装指南](docs/INSTALLATION.md)。

## 为什么值得把项目留在这里

- **依据跟得上结论**：原件、引用、人工确认和修改历史分开保存。
- **人保留决定权**：候选记录不自动成为事实；执行、具体操作和成果验收各有明确边界。
- **遇到中断先核对**：保留原提交身份和回执，不用重新执行冒充恢复。
- **能带走，也能回看**：原件与成果可下载，记录可比较，项目介绍可离线导出。
- **困难留在系统里**：界面使用“项目、任务、资料、记录、成果”等短名称，解释放在需要的时候。

## 面向开发者

```sh
npm run check                 # 静态结构、接口契约、真实 SQLite/HTTP 与故障回归
npm run test:browser:core      # 核心浏览器流程，使用确定性执行夹具
npm run build:release -- /absolute/path/to/new-release --engine-source vendor/agenthub/backend
```

测试默认阻止模型网络调用。浏览器测试需要安装 Chrome，CI 使用锁定的 Chromium。质量检查证明其覆盖范围内的软件行为；不把测试条数换算成真实任务成功率。

| 文档 | 内容 |
|---|---|
| [安装与配置](docs/INSTALLATION.md) | 环境、启动、资料目录与自有执行引擎 |
| [账号与邮箱](docs/ACCOUNTS.md) | 注册、密码登录、发件设置与原项目绑定 |
| [模型连接](docs/MODELS.md) | 获取型号、个人连接、内置模型与费用设置 |
| [使用指南](docs/USER_GUIDE.md) | 从第一个项目到交付、修订与复盘 |
| [扩展接入](docs/EXTENSIONS.md) | Codex / DeepSeek Harness 的打包与连接 |
| [架构](docs/ARCHITECTURE.md) | 数据、状态、执行和权限边界 |
| [接口](docs/API.md) | 契约、认证、主要入口与错误处理 |
| [开发与测试](docs/DEVELOPMENT.md) | 目录结构、质量门禁和复现验证 |
| [部署](docs/DEPLOYMENT.md) | 容器、反向代理、备份和回退 |
| [维护](docs/OPERATIONS.md) | 详细运行、恢复与升级参考 |
| [当前使用范围](docs/LIMITATIONS.md) | 平台、宿主兼容性和恢复边界 |

## 参与改进

遇到问题，请通过 [Issues](https://github.com/weijiakang8-dotcom/synplex/issues) 提供操作步骤、预期与实际结果、运行版本及脱敏后的问题编号。欢迎围绕真实任务提交反馈和改进，详见 [贡献指南](CONTRIBUTING.md)。

## 开源与致谢

采用 [Apache-2.0](LICENSE) 许可证。融合工作台承接 AgentHub 的执行能力与 Weave 的项目记录思想；引擎源码随 `vendor/agenthub` 保留原许可证。第三方依赖和用途见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
