# 安装与配置

## 1. 准备环境

- Node.js **26.x**（本版本主要核验 26.11.0）、npm、Git。
- macOS 内置 `lsof`；Linux 需安装 `lsof`。Node 22.16 是部分基础 API 的最低版本，完整资料解析请使用 Node 26。
- 普通资料整理不需要 Python、模型账号或外部数据库。
- 使用自有执行引擎时，另需 Python 3.11、uv、PostgreSQL 16 工具和 Valkey。相关环境独立创建，不修改其他工具的环境。

```sh
git clone https://github.com/weijiakang8-dotcom/Agenthub.git
cd Agenthub
npm ci --ignore-scripts
npm run open:workspace
```

启动窗口会检查依赖与资料目录，工作台默认只监听 `127.0.0.1:5200`。正常关闭该窗口会关闭自己启动的网页服务，不控制其他 Agent。

Mac 可以双击 `打开Synplex.command`。如果没有自动打开浏览器，打开资料目录内生成的 `打开Synplex.html`；连接码五分钟有效，只能使用一次。不要复制正式密钥到网页。

## 2. 选择资料位置

默认资料位于 `.runtime/workspace`，不进入 Git。首次启动前可设置：

```sh
export SYNPLEX_WORKSPACE_DATA_DIR=/absolute/path/to/private-workspace
export SYNPLEX_WORKSPACE_PORT=5200
npm run open:workspace
```

新资料目录由程序按仅本人可访问的权限创建。已存在的目录需要属于当前用户且权限为 `700`。同一份资料同时只启动一个工作台；端口或项目范围与已有配置冲突时会停止，不会覆盖。

`.env.example` 是变量说明，不会自动加载。Mac 启动器继承当前环境；终端请明确 `export`。不要把示例模板误当作已经设置好的连接。

## 3. 开始第一个项目

进入网页后选择“新建项目”，添加资料并核对候选记录。尚未配置执行工具时，可以完整使用资料、记录、任务准备和扩展辅助，不会产生模型费用。

## 4. 配置执行工具

执行器配置位于资料目录的 `executors.json`，权限必须为 `600`。严格格式以 `services/workspace/executors.mjs` 为准；不能加入未知字段。独立 Codex 执行目录不能复用活动宿主 HOME。

自有引擎源码已随仓库提供，不需要访问作者电脑上的旧项目：

```sh
node scripts/runtime/engine-environment.mjs install /absolute/path/to/new-python-env vendor/agenthub/backend /absolute/path/to/python3.11 /absolute/path/to/uv /absolute/path/to/postgresql/bin
```

随后用新环境 Python 创建独立运行目录：

```sh
/absolute/path/to/new-python-env/bin/python integrations/agenthub/engine_runtime.py setup --root /absolute/path/to/new-engine-data --backend vendor/agenthub/backend --postgres-bin /absolute/path/to/postgresql/bin --valkey /absolute/path/to/valkey-server
```

初始模型停用，不读取其他 Agent 的密钥。使用 `--help` 查阅当前命令；连接供应商后才启用执行。模型连接、联合启动及备份命令见[维护手册](OPERATIONS.md)。本仓库不附送模型额度，实际费用由你选择的服务提供商收取。

## 5. 更新

更新前正常关闭自己的工作台，保存数据库、原文件和配置的联合备份，再切换程序版本。不要用 `git clean`、覆盖数据库或强制重置任务来处理启动失败。具体恢复与回退步骤见[部署指南](DEPLOYMENT.md)。
