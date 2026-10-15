# 部署与发布

## 部署形态

Synplex 默认是个人私有工作台。公网部署使用同一位所有者的独立空间：HTTPS → 访问认证 → 一次性工作台连接 → 准确项目权限。它不是把资料库公开给所有访客的注册平台。

源码仓库包含容器定义、依赖锁、私有配置模板和自动质量门。容器部署工作台，不自动安装或复用运营者电脑上的 Codex、DSH、模型凭据或执行环境；执行工具需要独立配置。

## 容器启动

需要 Docker Engine 与 Compose v2。请预留构建和回退镜像空间，不在接近满盘时强行发布。

1. 在服务器的私有目录创建访问密码文件，例如使用系统 `htpasswd -cB /private/path/synplex-access.htpasswd your-user`；交互输入密码，不写入命令历史。
2. 文件仅允许维护者和容器用户读取；可使用维护者所有、GID 1000、权限 640 的独立文件。不要使用示例或共用密码。
3. 将 `deploy/.env.example` 复制到仓库外的私有配置文件，填写准确 HTTPS Origin 和密码文件路径。
4. 启动：

```sh
docker compose --env-file /private/path/deployment.env -f deploy/compose.yml build
docker compose --env-file /private/path/deployment.env -f deploy/compose.yml up -d
```

服务只发布到服务器 loopback 的 5260 端口。已有 HTTPS 代理将站点转发到该地址；容器代理要求访问认证，再把请求转发到同容器内的 loopback 工作台。不要把 5200 直接发布到公网，不删除 Origin 或会话保护。

## 连接自己的工作台

正常启动后，一次性入口保存在容器数据目录内。维护者在私有终端刷新入口：

```sh
docker compose --env-file /private/path/deployment.env -f deploy/compose.yml exec workspace node services/workspace/connect.mjs
```

然后在该终端读取 `/var/lib/synplex/打开Synplex.html` 中 `name="pair"` 的一次性值，并在 HTTPS 页面“连接码”中输入。不要把正式 token 当连接码，不把连接码输出到 CI 日志。

## 原线上 AgentHub 的切换要求

旧站使用专用生产 runner 和 root 管理的 `/usr/local/sbin/deploy-agenthub`，它只接受旧目录结构与原健康协议。**这个固定脚本不能部署融合工作台，不能通过删掉迁移检查或伪造健康字段来兼容。**

切站前必须由服务器管理员安装新版部署入口、备份旧数据库与成果、确认空闲资源并配置认证。先用独立端口验证新版，再修改 HTTPS 路由。旧 AgentHub 容器、原数据库与证书保留，原数据不自动迁入新工作台。

`Deploy Synplex` 工作流默认先做只读部署预检。服务器没有已安装的受控新版入口时会明确失败，不关闭旧站。管理员按仓库脚本安装入口后，才可运行正式发布。不要授予 runner 通用 sudo 或 Docker 组权限。

## 验证与回退

- 本机软件与浏览器门通过后，再验证容器构建、无认证拒绝、正确认证、一次性连接、资料导入和原件下载。
- 新站正式切换前，保留旧站路由配置、版本和数据备份。切换失败将 HTTPS 路由恢复到旧站，不回滚或覆盖新旧业务数据库。
- 工作台后续升级前，正常关闭其服务，备份资料卷、程序版本与私有配置；新版本不兼容时切回旧程序，不能擅自降级数据库。
- 公网健康只说明当前服务响应；执行器、模型与真实交付分别验收。

## 配置和密钥

服务器私有配置、访问密码文件、证书私钥、模型密钥、备份和资料卷均不进入 Git。容器默认非 root、只读程序文件系统、无额外 capabilities，限制内存/进程与日志增长。维护命令仍须使用自己的私有路径。

## 管理员安装发布入口

仓库提供 `deploy/deploy-synplex`。审阅后安装为 root 所有、不可由 runner 修改的 `/usr/local/sbin/deploy-synplex`，仅允许生产 runner 对该入口传入完整 SHA；不要授予通用 sudo。它要求至少 8 GiB 可用空间，不会自动清理服务器。

配置放在 root 管理的 `/etc/synplex/deployment.env`，包含模板变量，以及只读健康验证使用的 `SYNPLEX_HEALTH_NETRC` 路径。netrc 文件归 root、权限 600；它不是源码资产。

由于现有 HTTPS 可能由宿主 Nginx、Docker Nginx 或其他代理提供，管理员需明确配置 `/etc/synplex/activate` 与 `/etc/synplex/rollback` 两个 root 管理、可执行的路由切换脚本，分别切向新版独立地址和恢复原路由。必须先验证代理能访问新版容器，不能假定容器内的 127.0.0.1 就是宿主。

入口按 main SHA 拉取隔离源码、构建、停止自己的上一工作台、备份资料卷、启动新版、调用明确路由切换并验证公开版本。失败时尝试恢复上一程序与原路由；保留新旧数据，不降级数据库。首次现场安装与两份路由脚本必须按实际服务器演练，仓库静态检查不代表生产切换已验收。
