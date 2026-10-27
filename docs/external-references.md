# Boris 的外部参考工具

支持公开 GitHub 仓库根链接，以及无需登录网页的静态 HTML、正文、直接引用的图片和 CSS。网页脚本不会执行，CSS 的嵌套资源不会递归抓取。动态截图、私有仓库、登录会话、LFS 实体文件和子模块不在第一版范围内。

## 使用

用户可以直接说：

> 参考 https://github.com/caoxing9/inkwave-game ，尽量保留原画面、功能、配色和文案，移植到当前应用。先读取源码，完整复用游戏资源，只做平台适配；单独列出后端和联机依赖。

Agent 使用 `fetch_reference({url})` 获取资料 ID 和索引；通过 `read_reference({id,path,offset,limit})` 分段读取，再使用 `copy_reference_files({id,paths,destination})` 复制。`paths` 可以选择目录；原路径保留在 `destination`（默认 `.`）下面，例如选择 `public/game/` 会写入 `public/game/`。字符分页使用 UTF-16 字符位置，`limit` 最大 40000；完整来源、校验值及排除清单可通过 `path: ":index"` 分页读取。二进制文件只返回读取元数据，复制时保留原字节。

调用 Boris 时，`edit_app({brief,referenceIds:[id],fidelity:true})` 传入资料，并启用保真模式。它保留原设计和语言，平台数据访问、权限、入口与埋点规则仍然适用。仓库许可证应与复用代码一起保留。

## 运行要求与隔离

- 需要已配置的私有 S3/R2 对象存储。资料使用 `private/reference/<projectId>/<referenceId>/`，计入账户存储配额，项目删除与存储校准会一起处理。资料不写入应用源码、构建目录或公开附件路由。
- 获取工具只发匿名 HTTPS GET，请求使用经过验证并固定到 TLS 连接的公网 DNS 地址；最多跟随三次重定向，每一跳重新验证。默认每文件 10 MiB、合计 50 MiB、2000 文件、120 秒。限额失败不返回“完整成功”。
- GitHub REST API 用来解析默认分支、commit 和目录；文件从 GitHub 官方固定 commit 的 raw 内容端点获取，逐一验证 Git blob ID，避免匿名 REST 接口每小时 60 次请求限制导致较大仓库无法获取。截断目录直接失败；符号链接、子模块和 LFS 指针列入排除项。
- 复制接口与恢复快照接口分开，不触发装包。依赖清单、锁文件、`.pi`、代理指令、凭据和平台入口等受到保护；图片、字体、原 HTML/JS 和不透明下载包可选择性复制。复制后仍需审阅并测试代码及依赖。
- Boris 从镜像可信目录启动，显式使用平台规则和扩展，关闭项目指令、扩展、技能及提示模板发现。扩展把普通读写/命令工具定位到 `/workspace/app`，参考工具只接受当前有效生成任务的令牌，并从该任务确定项目范围。
- 静态快照先经过主站项目鉴权，再跳到独立、按应用签名的预览域。签名一小时过期，刷新原预览入口可重新取得；`SANDBOX_INTERNAL_TOKEN` 必须在 API 与 Worker 保持一致。`snap-` 前缀禁止用户申请。原有 `/api/snap/<appId>/` 资源前缀继续有效。
- 获取工具的网络限制不等于整个现有代码沙箱的出站防火墙；Boris 的 Bash/构建能力仍然存在。资料按不可信数据处理，禁用自动加载只能降低风险，不能替代代码审阅和生产环境的网络隔离。

修改后需重新构建并上线 API/web 与两个沙箱镜像/Worker，旧镜像没有参考扩展和复制程序。此改动不会自动发布用户应用。

## 获取超时排查

2026-10-27 的生产排查确认 INKWAVE 获取发生了三次超时。通过临时 SSH 在生产 Worker 中只读测量：同一获取器下载固定 commit 的 168 个文件（6,481,862 字节）约 6.4 秒；数据库往返与主要配额查询约 2–4 毫秒；R2 读取一个不存在对象约 275–431 毫秒。GitHub 可连通，DNS 固定连接可以成功，当前测量没有出现 GitHub 限流或 IPv6 连接失败。

旧代码在共享的 120 秒预算内逐文件串行调用 `StorageService.put`。每次调用除配额预留/结算外，还会先 GET 旧对象再 PUT 新对象；168 个文件累积约 336 次串行存储请求，持久化成为瓶颈。此前错误只有通用 TimeoutError，没有记录阶段，无法从 UI 区分下载与上传。

参考持久化现改为最多 6 个唯一对象并发上传，继续使用原配额事务和完整性检查。全部上传成功后才写 manifest；失败会等待在途上传结束再回滚。生产日志新增 `reference_started`、`reference_downloaded`、`reference_upload_progress`、`reference_completed` 和 `reference_failed`，可按资料 ID 关联，包含累计耗时、对象数量及失败阶段；超时也会向 Agent 返回阶段和已存对象数。

此次生产诊断没有上传测试对象、修改业务数据或部署修复；临时 SSH 公钥已撤销。修复的并发、去重、失败回滚和超时提示使用本地自动测试验证，上线后仍需通过真实应用请求确认完整获取耗时。

## INKWAVE 样例

运行 `bun api/scripts/verify-inkwave-reference.ts` 可获取当前公开默认分支并固定 commit，在系统临时目录创建 Vite 样例：逐字节复制 `public/game/`、下载包和许可证并验证校验值，沿用原 React iframe 外壳，适配导出及 Vite 路径前缀，保留 Lovbase 入口与埋点。复制验证后仅修改游戏中的局域网版下载链接，让它也适配快照前缀；报告单独列出这处源码修改。

该脚本不运行下载的代码、不解压下载包、不安装仓库依赖。它输出临时样例路径和 `reference-report.json`；视觉、鼠标锁定与真实联机测试应在受控预览环境另行执行并记录，源码复制成功不代表外部 WSS、PeerJS 或 Next.js API 已经可用。

2026-10-27 本地验收固定到 `9f5d022a4376cefe8547b51c6c1b15bd3303f552`（MIT）：

- 80 个文件，共 6,197,341 字节，复制时校验全部一致；上述下载链接为之后的唯一游戏源码适配。
- 使用平台模板依赖、关闭安装脚本后，样例类型检查和带 `/api/snap/reference/` 前缀的构建通过。
- 实际浏览器验证中英文菜单、单机地图/角色/HUD 画面、Titan One/Rubik 字体加载，以及快照前缀下的资源和下载链接。`mode=public&room=REFTEST` 已传入游戏 iframe，房间输入框显示 `REFTEST`。
- 点击进入对战后，当前自动化浏览器会话拒绝鼠标锁定，游戏显示重试提示；尚不能判定完整鼠标瞄准/射击验收通过。独立生产预览域和真实用户手势仍需复测。
- 测试浏览器禁用了所有非本地网络。`/api/rooms`、`/api/multiplayer-status` 返回 404；真实联机、Next.js API、Teable 和外部 WSS/PeerJS 均未验证可用。
- 冒烟测试启动真实 pi 0.73.1 进程，但使用模拟模型服务，仅验证七个工具注册和代理回合协议；未使用 Lovbase 测试账号，也未完成真实模型驱动 Boris 移植的端到端对话。在应用树放入恶意 AGENTS/SYSTEM、`.pi` 扩展/包配置和安装脚本后，它们未被自动加载或执行。本地 runner 镜像构建和 Linux 容器内二进制复制验证通过。Cloudflare 镜像/Worker 未部署验收。
- 全量自动测试 376 通过、54 跳过、0 失败，类型检查、lint 和构建通过。跳过项包含需要真实 S3/PostgreSQL 的集成测试；参考服务重启后的读取与项目隔离使用存储替身验证，尚未在部署环境验证容器重建后的真实对象存储读取。

自动回归：`bun test api/tests/references.test.ts api/tests/mcp-network.test.ts sandbox/tests/reference-copy.test.ts`。完整验证另运行 `bun test`、`bun run typecheck`、`bun run lint` 和 `bun run build`。
