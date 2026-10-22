# Free / Pro 权益与运维 / Entitlements and operations

套餐与价格唯一来源为 `core/src/plans.ts`。服务端通过 `effectivePlan` 按已经支付的有效覆盖期判断套餐，不依赖客户端传入的套餐或仅靠 webhook 更新过期状态。

| 权益 / Entitlement | Free | Pro |
| --- | --- | --- |
| 每月额度 / Monthly credits | 30 | 500 |
| 项目 / Projects | 2 | 25 |
| 账号存储 / Account storage | 200 MB | 5,000 MB |
| 发布应用 / Published apps | 1 | 25 |
| BYOK、自选子域名、只读直连、完整导出 / Exclusive capabilities | — | 支持 / Included |
| 生成队列 / Generation queue | 普通 / Standard | 优先 / Priority |

Pro $25/月或 $240/年，年付也按月提供额度；额度包 200/$10、1,000/$45、5,000/$200。到期不删除已有项目、数据或发布文件。超过 Free 项目、容量或发布数量限制时，限制新增、写入或再次发布；查询、删除、结构清理仍可进行。到期停用 BYOK、直连及完整下载；普通 SQL/源码查看编辑仍保留，但新增内容受容量限制。

Plans are evaluated server-side on every protected action. Expiry preserves existing projects, data and published pages; Free limits govern growth and exclusive features stop. Annual Pro renews its credit allowance monthly. Purchased wallet credits survive plan changes.

## 账号容量 / Account storage

- 数据库：账号所有项目 schema 的物理表、索引与 TOAST 大小，实时从 PostgreSQL 查询。DELETE 允许在超额时执行，但可能要等 autovacuum 或运维回收后才减少物理占用；删除表/项目可直接清理。
- 文件清单：持久化源码按解码后的实际字节计量，附件（含 data URL 内联）、头像、封面、构建快照与发布文件均计入。构建和发布为独立副本，分别计量。Sheets 持久化导入快照也计入。
- 依赖、容器运行缓存、临时导出和平台日志不计入。
- 数据写入使用账号级 PostgreSQL advisory transaction lock；普通写入前检查、提交前复核。并发上传先预留增长差额，同一对象不能同时预留。上传/覆盖结算失败回滚原对象后释放预留；回滚失败保留预留等待校准。删除成功才释放清单容量。
- `lb_storage_files` 为清单，`lb_storage_reservations` 为有一小时期限的预留。`lb_publish_reservations` 预占账号发布名额；失败释放。过期预留在后续预留时清理。

Account storage combines physical tenant relations and durable content bytes across every project. Dependency trees, runtime caches, temporary exports and platform logs are excluded. Replacement uploads reserve their positive delta, restore old bytes on failure, and release capacity after successful deletion. Cleanup remains available above quota.

## 迁移与校准 / Migration and reconciliation

SchemaService 在应用启动时幂等新增权益、用量账本、清单、预留及直连元数据表和索引。不会删除历史数据。旧源码快照可继续读取；文本仍为 `{path,content}`，二进制为 `{path,content,encoding:"base64"}`。旧快照的真实字节即使尚未回填清单，也在容量查询中计入。

Worker 启动及每 5 分钟运行 StorageReconciler。逐项目读取内联附件、逐应用回填源码，分页列举上传和沙箱 bucket，再按账号提交校准；可重复运行。只有完整成功的对象列举才能清理对象清单；内联附件使用独立清单键，删除后即使未配置 bucket 也能释放用量。有活动预留的账号跳过，校准开始后新写入的清单保留。设置页展示总用量、分类和上限；预留可从 `lb_storage_reservations` 查询。

首次上线前先备份数据库，保持写入入口关闭，使用与 web 一致的配置启动 worker，等待首次 storage reconciliation 成功，再开放入口。配置中的 bucket/endpoint 必须能列出历史对象；列举失败应先修复凭据，不能手工将历史用量归零。web、worker、sandbox 必须一起更新，以保证每个持久化路径都支持预留回调。

Migrations are additive and idempotent. Start the updated worker and complete the initial inventory before reopening writes on an existing installation. Reconciliation runs at startup and every five minutes; it skips active reservations and preserves newer manifest mutations. Legacy text snapshots remain readable, and binary snapshots decode to their original bytes. Historical lockfiles absent from old snapshots cannot be reconstructed automatically.

## 数据库只读直连 / Read-only connections

在 web 与 worker 上配置 `.env.example` 中的：

```dotenv
DATABASE_PUBLIC_HOST=db.example.com
DATABASE_PUBLIC_PORT=5432
DATABASE_PUBLIC_NAME=lovbase
DATABASE_PUBLIC_SSLMODE=verify-full
PG_DUMP_PATH=pg_dump
```

这些地址只用于向用户展示外部连接信息，不能填写平台用户名或密码。托管数据库需单独开放可达地址、配置可信 TLS 证书与访问控制；客户端按服务商要求安装 CA。开发环境可使用本机端口及 `sslmode=disable`。缺少 HOST 时 UI 明确提示未配置，拒绝创建凭据。

项目页「Pro 工具」支持查看地址、创建/重置密码与撤销。每项目使用独立 `ro_<projectId>` LOGIN，只有本项目 schema 的 USAGE/SELECT，未来由平台账号创建的表自动授予 SELECT；无 `ws_*` 成员关系，不能继承写入角色。连接数限制为 3，statement_timeout 为 30 秒。密码仅返回一次；数据库保存密码校验值，应用不保存明文。

Stripe 订阅事件提交后立即同步直连权限与等待任务。worker 每分钟复核到期状态；直连 LOGIN 的 VALID UNTIL 与已付覆盖期一致。到期、撤销或项目删除会禁用登录并终止已有会话；重新订阅后需重新创建已撤销的凭据。重置密码也终止旧会话。

Public connection coordinates are configured separately from platform credentials. Use TLS with a trusted CA in production. Each project receives a SELECT-only role with future-table grants, no write-role membership, and a password shown once. Expiry/revocation disables login and terminates sessions; the worker reconciles every minute in addition to immediate billing-event updates.

## 完整导出 / Complete exports

登录并通过项目归属和有效 Pro 检查后下载：

- `GET /api/projects/:projectId/export/sql`：PostgreSQL 17 `pg_dump` plain SQL，一致性快照，指定项目 schema，包含结构与全部数据，排除 owner/ACL，不导出平台账号。使用 `psql` 恢复至空数据库。
- `GET /api/projects/:projectId/export/source`：项目全部应用的源码 ZIP，路径为 `apps/<appId>/...`，包括配置、锁文件及静态/二进制资源。排除 `.env`（保留 `.env.example`）、密钥/凭据文件、依赖、构建与缓存目录。不要把生产秘密硬编码进源码。

响应 `Cache-Control: no-store`，流式传输并处理断开。源码采用 repeatable-read 游标逐文件读取，避免同时加载整个项目；现有 JSON 快照格式意味着单个文件仍需一次解码到内存。SQL 子进程在下载取消时终止，凭据不放入参数或错误消息。

运行 Docker 镜像已安装 PostgreSQL 17 客户端。macOS 本地可用 `brew install postgresql@17`，设置 `PG_DUMP_PATH=/opt/homebrew/opt/postgresql@17/bin/pg_dump`。不要用更旧的 pg_dump 连接 PostgreSQL 17。

Authenticated owner-only downloads provide a PostgreSQL 17 schema/data dump and source ZIP for all project apps. SQL excludes platform accounts, ownership and ACLs. Source includes lockfiles and binary resources, excludes known secret/dependency/cache paths, and reads one file at a time. The runtime image includes the matching client.

## 生成排队与计费 / Scheduling and billing

BullMQ 与 Redis 容器名额分配使用相同的 Pro/Free 优先级。同级按原始入队时间排序，不抢占执行中的任务。Free 等待 10 分钟提升至 Pro 同级，保留原始时间。每分钟重算等待任务；订阅事件立即更新等待队列，执行与申请容量前复核套餐。取消、相同 requestId 重试及恢复沿用已有作业流程。

所有生产模型入口（聊天、命名、结构生成重试与 coding sandbox）经过用量观察器。每次 provider 请求生成独立 ID，记录 `lb_model_requests` 的输入、输出、缓存用量，按当前模型费率定价。平台账本以 `model:<requestId>` 或 `container:<runId>` 为幂等键，数据库唯一索引避免重复扣款。

`lb_generation_runs` 记录 coding run 和实测容器时长，模型与容器分开扣费，不再有固定 20 额度保底。BYOK 模型额度为 0，实际容器时间仍收费。零额度 BYOK 用量仍入账。provider 缺失用量或请求失败时标记 `usage_missing`，不估扣；已测但记账失败的请求保持 `measured`，每分钟幂等重试。超过 31 分钟未完成的运行标记 `interrupted`；进程崩溃而未持久化的容器时长不补猜。

后台核查：按 `lb_model_requests.status IN ('usage_missing','measured')`、`run_id` 查询异常，结合 provider request 日志调查；不要用预计 token 手工补扣。平台模型费率、缓存输入费率和 markup 仍由现有计费配置控制。

Pro has priority without preempting active work; Free ages into the same priority after ten minutes. Provider usage is persisted per request; retries incur only their own measured costs, while reconciliation cannot double-debit. Missing usage is flagged, not estimated. BYOK avoids model credits and retains measured container charges. Unmeasured crash time is never invented.

## 支付与本地验证 / Payment and validation

所有升级入口统一进入 `/pricing?billing=monthly`；在价格页选择 $25/月或 $240/年，再调用 Stripe Checkout。Pro 的 Business 意向也在价格页登记，Business 显示当前套餐。返回路径限制为站内主页、设置、价格和项目页（保留 app 参数）；价格页支付保留 `billing=monthly|yearly`，成功后等待服务端确认并刷新权益。支付配置与 Stripe CLI 步骤见 README。

价格页提供固定可见的「返回上一页」按钮，使用记录的站内来源地址；无来源时返回 `/home`。支付成功或取消先返回价格页，再由返回按钮回到来源页面。每个标签页使用 `sessionStorage` 最多保留 30 个外围页面的位置，URL 中的付款结果参数不拆分位置记录；月付/年付共用价格页位置。只记录窗口和 `data-page-scroll` 标记的设置、项目列表、后台容器，不记录聊天区、代码区或沙箱 iframe。存储只包含地址、坐标，不存聊天记录、源码或页面 HTML；存储不可用时在当前运行期间降级为内存。站内业务数据继续使用 Router 的默认 SWR 缓存，跨站整页返回重新加载数据后恢复坐标。

此次验证以本地与 Stripe Sandbox 为准。生产部署、正式收款密钥与生产外部数据库地址/TLS 由独立上线流程执行。

```sh
bun run test
bun run typecheck
bun run lint
bun run build
```

真实集成测试使用独立、可丢弃的 PostgreSQL 17 数据库和 MinIO 测试 bucket，禁止指向生产或日常开发库。`ENTITLEMENTS_TEST_DATABASE_URL` 启用权益集成测试，`TEMPLATE_TEST_DATABASE_URL` 启用模板测试；同一测试进程可共用独立数据库。设置 `TEST_PG_DUMP_PATH` 和 `TEST_PSQL_PATH` 指定 PostgreSQL 17 客户端。`S3_TEST_ENDPOINT`、`S3_TEST_BUCKET`、`S3_TEST_KEY`、`S3_TEST_SECRET` 启用对象存储测试。Redis 测试在安装了 `redis-server` 时自行启动隔离临时实例，无需现有 Redis 数据。

Use disposable PostgreSQL 17 and MinIO test resources for integration tests; never point test URLs at a production or everyday development database. Redis suites launch an isolated temporary server. Validate Stripe with test keys/cards only. Deployment and live billing remain separate operations.
