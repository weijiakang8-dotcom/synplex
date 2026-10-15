# 工作台服务

负责准确项目权限、原件与来源、候选核对、任务准备、执行回执、成果和追加修订。使用 Node 原生 SQLite，运行目录不随源码发布。

- [安装与运行](../../docs/INSTALLATION.md)
- [接口与六工具协议](../../docs/API.md)
- [数据和执行架构](../../docs/ARCHITECTURE.md)
- [运行、恢复与升级](../../docs/OPERATIONS.md)
- [使用边界](../../docs/LIMITATIONS.md)

`createWorkspaceServer` 仅监听 loopback。`server.mjs` 加载仓库内正式模块，不读取其他 Agent 的工作区。`LocalProjects` 管理一位本机所有者的准确项目范围，不是匿名多租户入口。

`ExecutionCoordinator` 只执行已配置、经用户明确开始的任务。冻结说明、授权、执行尝试、原远端身份、回执与正式结果分别持久化；未知结果不重发，回写失败只补记录。

HTTPS 反向代理可显式配置 `SYNPLEX_PUBLIC_ORIGIN`，它只增加一个准确的浏览器 Origin 和 Secure 会话 Cookie；loopback socket、Host、凭据和项目权限检查保持生效。代理必须另设访问认证，不能把单人资料库公开给匿名用户。
