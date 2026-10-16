# 部署与发布

## 部署形态

Synplex 提供邮箱注册、登录名或邮箱登录、验证码找回密码。每个账号使用独立的项目、资料、模型连接与执行身份。公网完整部署路径为 HTTPS → 部署访问保护 → 账号登录 → 准确项目权限。先配置发件服务，再开放注册，详见[账号与邮箱](ACCOUNTS.md)。

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

## 登录与原工作台绑定

普通用户从 `/app` 注册或登录，不需要连接码。维护者先在容器内运行 `python3 scripts/runtime/configure-email.py /var/lib/synplex/workspace` 配置发件服务；不要把密钥写入 Compose、命令行参数或构建日志。

下面的一次性入口仅用于原所有者进入尚未绑定账号的旧资料。进入后通过“绑定邮箱”明确带入原项目；不能让第一个普通注册者自动获得旧数据。资料形态容器使用 `/var/lib/synplex`，完整形态使用 `/var/lib/synplex/workspace`。

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

## 完整聊天与执行部署

`deploy/Dockerfile.full` 与 `deploy/compose.full.yml` 包含 Node、锁定 Python 依赖、独立 PostgreSQL、Redis 7.0、API、worker 和网站代理，共用受控 loopback 网络；仅网站端口可由宿主访问。使用独立数据卷，不挂载旧生产卷或 Docker socket。模型仍须由管理员在网页明确添加。

该配方已通过隔离 Linux 容器的真实构建、独立后台启动、认证、单次连接、跨站拒绝、资料核对和精确原件下载验证。它需要单独的数据卷；既有站点先完成资料迁移和真实代理验收，再切换路由。现有 `compose.yml` 的资料工作台形态继续保留，不能把它误作完整执行部署。公开首页仅放行 `/` 与明确的首页资产，私人工作台、接口、下载和扩展继续保留认证。


使用完整部署配置时，将相同私有配置中的 `SYNPLEX_HTTP_PORT` 设为一个空闲本机端口（默认 5262）：

```sh
docker compose --project-name synplex-full --env-file /private/path/deployment.env -f deploy/compose.full.yml build
docker compose --project-name synplex-full --env-file /private/path/deployment.env -f deploy/compose.full.yml up -d
```

腾讯云服务器访问依赖主站缓慢时，可在构建命令追加 `--build-arg SYNPLEX_APT_MIRROR=mirrors.cloud.tencent.com --build-arg SYNPLEX_PYPI_INDEX=https://mirrors.cloud.tencent.com/pypi/simple`，改用腾讯云的 Debian/PyPI 镜像传输；Debian 签名、Python 锁定哈希、Node 锁和 pgvector 来源校验保留。默认仍使用官方主站，其他镜像地址会被拒绝。

完整部署的工作台资料位于容器内 `/var/lib/synplex/workspace`，执行后台与数据库位于同一私有卷中的独立目录。先登录受保护工作台，在“任务 → 模型设置”添加连接，再开始真实任务。网站不会自动取得运营者本机的账号、模型或邮件凭据。维护者刷新原所有者的一次性入口可用相同 Compose 命令的 `exec workspace node services/workspace/connect.mjs`，读取工作台子目录的入口。公开首页包含动态星空，并尊重系统的“减少动态效果”。

目前 `deploy/deploy-synplex` 是既有资料工作台的受限发布入口；不能把它当成完整后台迁移器。完整部署首次切站需管理员按现场代理、私有配置和备份操作，不能只推送源码就宣称线上已有执行能力。CI 会构建并验证完整后台，不替代服务器的切流授权与模型设置。

### 从纯资料工作台迁入完整后台

正常关闭原工作台并制作已核对的 `recovery.mjs backup` 快照。在独立新卷完成完整后台初次安装，然后正常关闭新后台。使用同一容器用户离线运行：

```sh
node deploy/migrate-materials.mjs /private/verified-snapshot /var/lib/synplex
```

迁移工具只接受没有执行连接、账号、新版业务数据和未决操作的纯资料快照，且目标必须是没有用户数据的完整安装。保留原快照与目标初始目录，原项目权限、原件、记录指纹不重建；连接路径映射到新卷，执行使用刚安装的独立后台。已有执行历史必须走联合恢复流程，不能用此工具换绑。失败时不自动启动、不重发、不删除原数据；切流前核对迁移回执和原件下载。恢复旧网站路由即可回到保留的旧实例，不能让旧程序读取新增账号数据。

纯资料迁移使用新安装的执行环境，不启用旧执行环境的恢复记录。迁移前的恢复信息保存在 `materials-recovery.json`，完成回执为上层目录的 `materials-migration.json`；回执仍处于准备状态时，启动门禁会拒绝运行。不要手工把 `recovery.json` 的执行标记改为启用来绕过联合恢复检查。
