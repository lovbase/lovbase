<img src=".github/assets/logo.svg" width="56" height="56" alt="Lovbase logo">

# Lovbase

[English](./README.md) · **简体中文**

一句话生成真实的 Postgres 数据库和可用的应用,改需求时已有数据一行不丢。

> MVP 验证中。AGPL-3.0,引擎部分 [`core/`](./core/README.md) 用 MIT。

## 这个项目真正在解的问题

让模型去改一个有数据的数据库结构,演示很容易,活下来很难。

用户说「把"名称"改成"公司全称"」。模型返回新结构。你用最自然的方式去 diff——按名字比——
看到的是一个字段消失了、一个字段出现了。于是你发出 `DROP COLUMN` 和 `ADD COLUMN`。
这一列的数据全没了,而用户得到的唯一提示是一个空白页面。

**把 prompt 写得更好并不能解决它。** 区分「改名」和「删了一个、又加了一个」所需要的信息,
根本不在模型的输出里。它必须在表示形式里。

## 答案

```
自然语言 → 带稳定 ID 的 IR → 确定性 diff → 白名单 DDL → 真实 Postgres
```

**LLM 从不直接写 SQL。** 它只产出一份 IR(`core/src/ir.ts`)——实体和字段,每个都带一个永不改变的 ID。
名字只是标签。剩下的全由确定性代码完成:

- **diff 按 ID 比,不按名字比。** 一个 `dbName` 变了但 ID 还在的字段就是 `rename_field`,
  编译出来是 `ALTER TABLE … RENAME COLUMN`,数据原地不动。
- **三种会丢数据的变更被显式标记**,停下来等 workspace 主人确认,而不是先执行再道歉。
- **DDL 是白名单。** 每一种变更都对应 `core/src/ddl.ts` 里手写的 SQL;模型的输出到这一层时
  是校验过的对象,不是一段待执行的字符串。
- **每个项目一个独立 Postgres schema**(`p_<id>`)+ 一个只有 DML 权限的角色(`ws_<id>`),
  任何东西出问题,影响范围就是一个租户。

这样做的回报是:**正确性不再是主观判断。**「它到底是改名了还是重建了」是 `rename_field` 对
`drop_field` + `add_field`。这正是 [eval 套件](./api/evals/README.md) 能做精确断言、
而不需要另一个模型当裁判的原因。

## 产品面

| 路由 | 说明 |
|---|---|
| `/` | 首页:提示框直接开建 + 项目列表(每个套餐的项目数上限在 `core/src/plans.ts`) |
| `/p/:id` | Builder:Agents / Preview / Database / Code 四个 tab |
| `/s/:token` | 分享链接:无需登录,可查看和录入数据,不能改结构 |
| `/settings` | BYOK:自己的 OpenAI 兼容端点 + key(AES-GCM 加密存储) |

### 生成提醒与意见反馈

侧栏的「通知」显示应用生成完成和任务失败的未读消息，可点击打开对应应用或标为已读。浏览器通知需要在通知窗口或账号设置中主动开启，并保持一个已登录的 Lovbase 页面打开；后台轮询不属于关闭页面后仍可送达的 Web Push。普通对话与取消任务不产生完成提醒。

侧栏底部的「意见反馈」支持建议、问题报告和最多 3 张截图（PNG/JPEG/WebP，每张 2 MB）。反馈及截图保存在 Postgres，无需配置对象存储；截图仅提交者和管理员可读。管理员在 `/admin` 的「客户反馈」中按状态筛选，并标记为待处理、处理中或已处理。每个账号每小时最多提交 10 条。

## 数据 API(给自己写的前端、或沙箱里的编码 agent 用)

鉴权:`Authorization: Bearer <api_token>`(Database tab 里能看到),或主人的登录态。

```
GET  /api/data/:id/schema        → { ir, ddl, schema }
POST /api/data/:id/sql           → { sql, params }  以 ws_<id> 角色、单条语句、事务内执行
POST /api/data/:id/schema        → { ir } 或 { message }  走 IR → diff → DDL 管线
```

`/sql` 的安全边界在 Postgres 权限,不在 SQL 解析:角色只有自己 schema 的 SELECT/INSERT/UPDATE/DELETE,
没有 CREATE/ALTER/DROP;走扩展协议所以一次只能一条语句;`SET LOCAL role/search_path/statement_timeout`
都在事务内,不会泄漏到连接池的下一个请求。改结构只有 `POST /schema` 这一条路,破坏性变更停在待确认。

## 本地开发

```bash
bun install
docker compose up -d                 # Postgres :5433、Redis :6379、MinIO :9000,并建好附件桶
cp .env.example app/.env             # 填 LLM_* 或 ANTHROPIC_API_KEY,并放开 S3_* 那一段
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # 生成应用跑在里面的镜像,一次
```

然后两个常驻进程,各开一个终端:

```bash
bun run runner                       # 沙箱 runner :8788(每个生成的应用一个容器)
bun run dev                          # rspack 监听 api/ + vite dev,http://localhost:3008
```

检查类命令:

```bash
bun run lint                         # oxlint(含分层规则)
bun run typecheck                    # api + app 的类型检查
bun run test                         # core 引擎 + 后端单测
bun run eval                         # 建模管线的 eval(会真的调模型)
```

`docker compose up -d` 会顺带把附件桶建好——应用自己从不建桶,生产环境那是面板上的一次性动作,
凭证也不该有这个权限。如果 9000 端口被占,用 `MINIO_PORT=9200 docker compose up -d`,
并把 `S3_ENDPOINT` 改成同一个端口。

`S3_*` 不配也能跑:附件会退回以 base64 内联,也就是把截图直接塞进 Postgres 里的对话记录,
之后每一轮都重新发给模型。临时看看没问题,要存数据就别这样。

`bun run dev` 会先把 `api/` 打一次包,再并行跑 rspack watch 和 vite——后端是编译产物,前端从 `@lovbase/api`
引它。改后端代码时 rspack 重新打包,vite 会跟着重载。

启动时自动建表、建 `lovbase_sql` 执行角色;要求 `DATABASE_URL` 的账号有 CREATEROLE。
环境变量在 `api/src/config/config.service.ts` 里集中声明并在启动时校验一次,填错的变量在启动就报错,
不会等到某条代码路径跑到才 500。

## Eval

建模管线有一套 eval,因为"模型大部分时候是对的"这种话没法写进 changelog。在
[`api/evals/`](./api/evals/README.md)。

它能做到**精确断言**的原因:模型的输出是一份校验过的 IR,而我们断言的是新旧 IR 之间的 **diff**。
`diffIR` 是基于稳定 ID 的纯函数,所以"它到底是改名了,还是删了重建"是 `rename_field` 对
`drop_field` + `add_field`,不是主观判断。不需要裁判模型、不需要评分标准、每次跑结果一致。

```
bun run eval

model                        pass   first try   avg tries   avg ms
gpt-5.6-sol                   95%        100%        1.00     6655

category                   gpt-5.6-sol
add                                3/3
rename                             4/4
modeling-judgment                  4/4
type-change                        2/2
preserve                           3/3
ambiguous                          2/2
adversarial                        2/3
```

真正要看的是 `first try`:管线最多重试三次,把 `validateIR` 的报错回喂给模型,所以光看 `pass`
会掩盖这个重试救回了多少。

唯一那条红是故意留的——一个把模型说服去提议清空所有表的注入。它保持红,是因为模型确实会照做,
而重点在于这件事到不了 Postgres:`diffIR` 会把结果标成破坏性变更,停在待确认。
**模型不是安全边界,管线才是。**

## 沙箱:两种运行方式,同一份代码

生成应用的代码在沙箱容器里由 pi 编写和运行。主应用只认 `SANDBOX_URL`,后面可以是:

| | Cloudflare(`sandbox/src/index.ts`) | Docker runner(`sandbox/runner/`) |
|---|---|---|
| 运行 | Cloudflare Sandbox(Containers + DO) | 任意 Docker 主机,一个 app 一个容器 |
| 文件持久化 | R2 快照 + Postgres 快照 | Docker 卷,容器重启不丢 |
| 预览地址 | `5173-<id>-<token>.<域名>` | 宿主机随机端口(生产前面放 Caddy 做通配子域) |
| 发布静态站 | R2 | 不支持(返回 501) |
| 隔离 | Cloudflare 托管 | 容器;多租户请给 Docker 装 gVisor(runsc) |
| 启动 | `cd sandbox && bun run dev` | `bun run runner` |

HTTP 接口只有一份,是 `sandbox/src/app.ts` 里的 Hono 路由;两边各实现 `sandbox/src/backend.ts` 的
`SandboxBackend`(exec / 读写文件 / 预览 / 销毁),差别全在那一层。主应用的客户端
(`api/src/modules/sandbox/sandbox.service.ts`)直接从路由类型推导,接口改了主应用编译就报错。

## 私有化部署(不依赖 Cloudflare)

```bash
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # 生成应用用的沙箱镜像
docker compose -f docker-compose.private.yml up -d                     # app + postgres + redis + minio + sandbox-runner
```

主应用镜像就是根目录的 `Dockerfile`。Postgres、统计事件、pi、模型 key 全在内网;模型走 BYOK 或内网网关。

## 部署:Railway 跑主应用,Cloudflare 跑沙箱

主应用是一个普通的 Node 进程:`app/server.mjs` 先挂 NestJS(`/api/*`、`/ingest/*`),再托管静态资源,
其余交给 TanStack Start。一个进程一个端口,后端和界面共用一个 DI 容器、一套连接池。
它和 Postgres 部署在同一个地方,所有数据库访问都是内网。沙箱留在 Cloudflare:一个 app 一个容器、
预览域名路由、闲置休眠、R2 静态托管都是平台给的。两边通过 HTTP 互调。

后端也能单独跑(`bun run --cwd api start`,即 `api/src/main.ts`)。要拆成两个服务时,
改的是部署方式,不是代码——`app/src/functions/_ctx.ts` 是唯一需要换成 HTTP 调用的地方。

### 1. Railway:主应用 + Postgres + Redis

新建项目,添加 Postgres 和 Redis 服务,再从这个仓库建一个服务(根目录 `Dockerfile`,`railway.toml` 已配好)。
Railway 的区域选离 Cloudflare 容器近的,沙箱回调主应用的那条链路会短一些。环境变量:

```
DATABASE_URL            Postgres 的私网连接串(账号要有 CREATEROLE)
REDIS_URL               Redis 的私网连接串(运行增量记录,默认保留 2 小时)
SQL_ROLE_PASSWORD       强密码;首次启动自动建 lovbase_sql 角色
BETTER_AUTH_SECRET
BETTER_AUTH_URL         https://你的域名
SANDBOX_URL             第 2 步部署出来的地址(https://lovbase.app)
SANDBOX_INTERNAL_TOKEN  和沙箱 Worker 的 INTERNAL_TOKEN 一致
ADMIN_EMAILS
LLM_BASE_URL LLM_API_KEY LLM_MODEL   平台默认模型;Pro 用户可以 BYOK
VITE_POSTHOG_KEY        构建期变量;不填则完全不启用分析(私有化部署请保持不填)
```

首次启动应用会自己建表,不需要跑迁移。域名接到 Railway 后,在 Cloudflare 上把 `lovbase.dev` 开橙云代理:
静态资源按 hash 缓存在边缘,`/api/*`、`/ingest/*` 和 server function 请求要加规则绕过缓存。

### 2. 沙箱 Worker(先发,主应用要指向它)

```bash
cd sandbox
wrangler secret put INTERNAL_TOKEN        # 主应用用同一个值访问
wrangler deploy                            # 本机要开着 Docker,会构建并推送容器镜像
```

发之前改 `sandbox/wrangler.jsonc`:`LOVBASE_API_URL` 和 `LOVBASE_PUBLIC_API_URL` 换成主应用的域名,
`SANDBOX_HTTP_PROXY` 留空(本地代理配在 `sandbox/.dev.vars`),`max_instances` 按需要调大。
沙箱用到 Containers,必须是 Workers 付费计划。

**域名划分**:产品在 `lovbase.dev`,用户产物(预览、发布的应用)全在 `lovbase.app`。
把不可信的生成代码放在另一个注册域名下,它就拿不到产品域名的 origin。

预览地址是从沙箱 Worker 被访问的主机名推导的,所以它绑在 `lovbase.app` 根域上,
预览就是 `5173-<sandbox>-<token>.lovbase.app`,只有一层,免费的 Universal SSL 正好覆盖。
换成 `*.sandbox.lovbase.app` 会变成两层,需要额外买证书,没必要。

### 3. 控制花费

Railway 是固定的小机器。Cloudflare 没有硬性的消费上限,超了就是按量计费,只能设用量告警,
所以沙箱的成本要靠结构去卡,这个项目里有三道:

- **额度系统**:对话按实际输入/输出 token 和模型档位计量,最低消耗 1 额度。生成任务按真实模型输入、输出、缓存用量与实际容器时间分别计费，
  已移除固定 20 额度保底。模型缺失用量时记录异常，只扣可核实费用。免费用户每月 30 额度。
- **`SANDBOX_SLOT_COUNT` + `max_instances`**:Redis 原子调度前者(默认 5),`sandbox/wrangler.jsonc`
  中的后者是平台硬上限。槽位数必须小于等于硬上限。
- **保温期 + `SANDBOX_SLEEP_AFTER`**:任务结束后,从最后一次真实编辑起保温 120 秒,随后静态快照接管,
  BullMQ 停止容器。平台的 5 分钟 idle timer 只作为最后兜底。

容器规格也能降,`instance_type` 从 `standard-1` 往下还有 `basic`、`dev`、`lite`,
但 Boris 要跑 bun install 和 vite,降之前先在测试项目上验证。

**想要账单完全封顶**:别用 Cloudflare Containers,把沙箱换成自带的 Docker runner,
跑在一台固定价格的服务器上(`docker-compose.runner.yml`),主应用的 `SANDBOX_URL` 指过去即可。
代价是没有发布静态站的能力,预览要自己配通配子域。

### 4. 收款(可选)

Pro 订阅和额度包通过 Stripe Checkout 收款，Business 保留联系入口。配置与本地沙盒测试步骤见下方「额度与套餐」。

## 结构

四个包,按部署单元拆:`core` 是纯函数引擎,`api` 是后端,`app` 是界面,`sandbox` 是跑生成应用的服务。

```
core/src/             IR + 基于稳定 ID 的 differ + 白名单 DDL 生成器。纯函数,谁都能依赖
core/src/plans.ts     套餐、价格、额度成本(前后端共用的唯一定义)
core/src/templates.ts 带版本号的中英文模板目录（见 templates/README.md）
templates/inventory/ 原创库存应用，供只读预览和可编辑副本共用

api/                  NestJS 后端。可以内嵌进 app 进程,也可以 `node dist/main.js` 单独跑
  src/config/         所有环境变量在这里声明 + 启动时校验一次
  src/database/       两个进程级连接池 + 建表
  src/common/         领域错误、Express⇄fetch 桥、全局鉴权守卫(@Public 才放行)
  src/modules/        auth · projects · apps · modeling · data · sql · roles · credits
                      billing · llm · sandbox · agent · analytics · templates · ingest · limits
  rspack.config.ts    SWC 打包(Nest 的 DI 需要 decorator metadata,esbuild 给不了)

app/                  TanStack Start:界面 + SSR
  src/functions/      server functions,按域分文件,全部经 _ctx.ts 鉴权后调 Nest 服务
  src/functions/_ctx.ts  唯一的鉴权入口,也是唯一知道 TanStack 请求机制的文件
  server.mjs          生产入口:Nest → 静态资源 → TanStack Start,一个进程一个端口

sandbox/src/app.ts    沙箱 HTTP API(Hono,两种后端共用)
sandbox/src/backend.ts SandboxBackend 接口
sandbox/src/index.ts  Cloudflare 后端(Containers + R2)
sandbox/runner/       Docker 后端(本地开发 / 私有化)
```

### 边界是被强制的,不是靠自觉

- **鉴权拿不到就编译不过**:业务服务只接受 `AccessService` 产出的 `UserCtx` / `ProjectCtx` / `AppCtx`,
  而它们只能由真实请求头换来。少写一行鉴权不会变成漏洞,会变成类型错误。
  控制器那侧是全局 `SessionGuard`,默认需要登录,`@Public()` 才放行。
- **依赖方向写在 `.oxlintrc.json` 里**:`app/` 不许 import `pg`、服务端 `better-auth` 或 `@lovbase/api` 的内部路径;
  `api/` 不许 import `@tanstack/*` 或 `react`(它要能脱离 app 单独跑);控制器不许直接查库。
  `bun run lint` 会拦。
- **API 的类型是构建产物**:`api` 用 tsc 输出 `dist/types`,`app` 只看这个,两边的编译选项不会互相干扰。


## 路由

```
/                     首页(未登录 = 官网落地页,已登录 = 模板 + 新建)
/pricing              价格
/projects             项目列表      /projects/:id   构建器
/share/:token         公开分享
/settings             账户与用量     /admin          管理后台
/api/data/:ws/{sql,schema,events}   数据 API(旧路径 /w/:ws/* 仍可用)
/api/billing/webhook  Stripe 支付与订阅事件
```

## 额度与套餐

Agent 对话按实际输入/输出 token 和模型档位计量,最低消耗 1 额度。生成任务按真实模型输入、输出、缓存用量与实际容器时间分别收费，
已移除固定 20 额度保底。聊天、命名与结构生成重试逐请求记账，缺失用量记录异常，不估扣模型费用。BYOK 对话不收取用户模型 token 的额度,
但平台沙箱运行时间仍会收费。额度按套餐每期发放,管理员可在 /admin 单独赠送。套餐、价格、额度与上限只在
`core/src/plans.ts` 里定义一次。

Pro 支持 $25/月或 $240/年，两种方式均每月提供 500 额度，年付不会一次发放全年额度。
额度包为 200/$10、1,000/$45、5,000/$200，购买额度进入钱包，不随订阅周期清零。
Business 继续登记联系意向。未配置支付时，Pro 和额度包购买入口显示暂未开放。

Free 为 2 个项目、账号总存储 200 MB、1 个发布应用；Pro 为 25 个项目、5 GB、25 个发布应用。
Pro 包含 BYOK、自选发布子域名、数据库只读直连、完整 SQL/源码导出和优先生成队列。
到期保留现有项目、数据和已发布页面，按 Free 限制新增与写入，并停用 Pro 专属能力。
配置、回填、校准及验证方式见 [Free/Pro 运维说明](docs/free-pro-entitlements.md)。

本地 Stripe 沙盒配置（只创建测试商品）：

1. 安装官方 Stripe CLI 并运行 `stripe login`，选择对应的沙盒账户。
2. 在 `app/.env` 填写同一沙盒的 `STRIPE_SECRET_KEY=sk_test_...`，并设置 `BETTER_AUTH_URL=http://localhost:3008`。
3. 运行 `bun run stripe:setup`，脚本按 `core/src/plans.ts` 创建或复用五个价格及 Customer Portal 配置，写入 `app/.env`。
4. 另开终端运行 `bun run stripe:listen` 并保持运行。脚本将签名密钥保存至 `app/.env`，回调转发至本地 `/api/billing/webhook`。
5. 重启应用（开发：`bun run dev`；构建后：`bun run start:web`），进入 `/pricing` 或 `/settings` 测试付款。

```dotenv
STRIPE_MODE=test
STRIPE_ACCOUNT_ID=acct_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_CREDITS_SMALL=price_...
STRIPE_PRICE_CREDITS_MEDIUM=price_...
STRIPE_PRICE_CREDITS_LARGE=price_...
STRIPE_PORTAL_CONFIGURATION=bpc_...
```

Hosted Checkout 不需要前端 publishable key。密钥仅保存在本地环境文件，不要提交到仓库。
正式环境必须显式设置 `STRIPE_MODE`；切换验收完成前保持 `disabled`。账户核验、迁移、发布暂停及人工退款步骤见 [Stripe 正式收款说明](docs/stripe-live.md)。
使用官方成功测试卡 `4242 4242 4242 4242`，任意未来到期日和三位 CVC；拒付测试卡为 `4000 0000 0000 0002`。
只在 Stripe 显示「沙盒」或「测试模式」时使用测试卡。

回调订阅 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、
`checkout.session.async_payment_failed`、`checkout.session.expired`、`customer.subscription.created`、
`customer.subscription.updated`、`customer.subscription.deleted`、`invoice.paid`、`invoice.payment_failed`。
应用校验原始请求签名并在数据库事务内去重；返回页面会等待回调确认到账。
Customer Portal 支持付款方式、发票和到期取消，关闭套餐切换。取消后权益保留至已付费期限结束，续费失败不会延长权益。
重启监听器后若签名密钥改变，需再次重启应用。

自动化回归：`bun test api/tests/billing.test.ts core/tests/billing.test.ts app/tests/mcp-client.test.ts`。
当前配置用于本地沙盒；正式收款需另行配置正式环境价格、密钥及可公开访问的 HTTPS 回调。
退款、争议处理和自动税费不在当前实现范围内。

## Google Sheets 导入（Composio，可选）

在 web 和 worker 进程配置同一个 `COMPOSIO_API_KEY`（Composio **Platform** 项目 key）。
未配置时，连接器目录显示配置提示，连接功能不可用。Node.js 要求至少 22.22.3。
首次连接会通过 Composio 托管 OAuth 创建仅含
`https://www.googleapis.com/auth/spreadsheets.readonly` 的 auth config，并将 config ID 保存到数据库。
也可通过 `COMPOSIO_SHEETS_AUTH_CONFIG_ID` 指定已配置只读权限的 auth config。
使用受限项目 key 时，需要会话管理、会话工具执行、连接管理权限；自动创建 config 还需要 auth config 写权限。
`BETTER_AUTH_URL` 必须是用户可访问的主应用地址，授权返回 `/api/integrations/google/callback`。

1. 从侧边栏或聊天「＋」菜单打开「连接器 → Google Sheets → 新建连接」，填写名称并连接 Google。
2. 为项目明确启用一个连接，粘贴表格编辑链接，点击「继续」。对话中提供链接也会打开该卡片。
3. 选择工作表、表头行和可选的 `A1:F500` 范围，读取后预览字段与样例。
4. 修改字段后点击「保存并校验字段」，确认导入后，后台先建表和导入，再生成界面。

每次最多 10,000 行数据、10 MiB 快照、1,000 列，并占用项目存储配额。无范围时按工作表网格读取；
网格超限时必须缩小范围，不会只取前几行而假装导入完整。完全空白行被跳过，公式保存读取时的计算结果；
带前导零的字符串保留为文本。日期自动识别仅接受 ISO 格式，模糊的地区日期保留文本，避免误转。
源表在分批读取时应保持不变；预览是本次读取的固定快照，确认后不再次拉取 Google 数据。

导入为新表，不同步、不回写。重复确认不会重复导入；界面生成失败后可重试生成，已导入数据保留。
更换连接或模型结构变更后，未完成的导入需要重新预览。断开个人连接会停用其所有项目绑定，已导入数据保留。
Google 凭证由 Composio 管理，浏览器和生成应用不持有平台 key。表格内容仅作为数据，模型只接收预览样本。

验证：`bun test api/tests/sheets.test.ts api/tests/sheet-imports.test.ts api/tests/composio.test.ts`。
数据库测试使用 PGlite 内嵌 PostgreSQL，默认运行，不需要 Docker。上线前还需用测试 Google 账户完成一次真实授权、
多工作表读取和导入验收，并测试撤销 Google 授权后的错误提示。

## 聊天技能

在项目聊天中打开「＋ → 技能」，可启用内置技能或导入单个 `SKILL.md`。
自定义技能在同一项目的所有子应用间共享；启用状态按用户独立保存，持续对后续消息生效。
Agent 会在相关任务中按需加载指引。建模和 UI 两项核心指引始终启用，首页技能目录仅供浏览。

导入文件需为 UTF-8 Markdown，不超过 64 KiB，包含 YAML frontmatter 和非空正文：

```md
---
name: project-conventions
description: 统一项目界面规范。
---
沿用现有组件，日期使用 YYYY-MM-DD 展示。
```

名称由 1–64 个小写字母、数字和单个连字符组成，不能以连字符开头或结尾；描述为 1–1024 个字符。
不允许与内置技能或当前项目技能重名。导入后自动为导入者启用，删除会从整个项目移除。
不导入 ZIP、附属文件或脚本，也不会安装额外的 Agent 工具。

运行 `bun test api/tests/skills.test.ts`，验证格式校验、持久化、隔离和 Agent 上下文。

### 远程 MCP 服务器

设置 `MCP_ENABLED=true` 后，在 **连接器 → 添加 MCP 服务器** 中填写名称和 HTTPS URL。连接保存在个人账户下；从项目中添加成功后，自动对当前项目启用，其他项目需单独启用。账户设置也可以管理连接。账户“停用”会阻止所有项目继续调用，项目开关仅影响当前项目。

支持公网 HTTPS **Streamable HTTP**，不支持本地进程、局域网地址或旧版 SSE。提供三种认证：

- **OAuth（默认）**：自动发现授权服务，支持 PKCE、动态客户端注册和客户端元数据文档；已有客户端可在高级选项中填写 Client ID 和 Client Secret。
- **Bearer token / API key**：默认使用 `Authorization: Bearer`；也可指定 `x-api-key` 等自定义请求头。
- **无需认证**：适用于公开 MCP 服务。

OAuth 回调地址为 `${BETTER_AUTH_URL}/api/integrations/mcp/callback`，客户端元数据地址为 `${BETTER_AUTH_URL}/api/integrations/mcp/client-metadata`。生产环境需配置可公开访问的 HTTPS `BETTER_AUTH_URL`，预注册客户端需登记上述回调地址。授权链接十分钟有效；取消或失效后可重新连接。令牌自动刷新，刷新失败会要求重新授权。凭据在服务端使用 `BETTER_AUTH_SECRET` 加密，请保持该密钥稳定。

**高级：MCP Registry 目录** 保留目录添加与同步功能。目录令牌只用于读取目录，不传递给目录内服务器；服务器认证可独立配置。同步保留已有服务器 ID 与项目启用关系，目录移除的服务器会标记不可用。

Agent 可发现已启用服务器的工具；写入或破坏性工具沿用对话内审批。保留 `MCP_TOOL_TIMEOUT_MS`、`MCP_MAX_RESULT_BYTES`、`MCP_MAX_SERVERS_PER_PROJECT` 和 `MCP_MAX_CALLS_PER_TURN` 限制。远程 URL、授权服务和 DNS 地址均需通过公网检查，不跟随 HTTP 重定向；请填写最终服务 URL。

### 从 Claude Code、Codex 和 Cursor 使用 Lovbase

点击侧边栏的 **MCP**，按对应客户端页签复制命令或 JSON。Lovbase 的入站服务地址是
`${BETTER_AUTH_URL}/mcp`，独立于上面的外部 MCP 连接器。`MCP_SERVER_ENABLED` 默认开启；
设为 `false` 可关闭入站访问。生产环境需使用规范的 HTTPS `BETTER_AUTH_URL`，本地开发支持
localhost HTTP，无需新增域名或独立服务。

```sh
claude mcp add --transport http lovbase https://你的域名/mcp
# 在 Claude Code 中运行 /mcp → lovbase → Authenticate
codex mcp add lovbase --url https://你的域名/mcp
codex mcp login lovbase
```

Cursor 和其他兼容客户端配置：

```json
{ "mcpServers": { "lovbase": { "url": "https://你的域名/mcp" } } }
```

VS Code 将 `mcpServers` 改为 `servers`，并为服务器增加 `"type": "http"`。
客户端需支持 Streamable HTTP、OAuth 授权码及 PKCE S256、公共客户端动态注册
（`token_endpoint_auth_method: none`）。发现端点为
`/.well-known/oauth-protected-resource/mcp` 和 `/.well-known/oauth-authorization-server`；
授权端点为 `/authorize`、`/token`、`/register`、`/revoke`。

在浏览器登录并同意后，客户端可以访问**当前及未来由自己拥有的全部项目**，包括创建项目和应用、
查询及修改数据、提交表结构、读取和编辑代码、调用 Agent、预览、构建和发布。删除项目、删除应用、
下线应用和确认破坏性表结构变更仍在网页完成。查询使用数据库只读事务，写入沿用工作区数据库角色。

`start_agent_run`、`preview_app`、`build_app`、`publish_app` 返回 `taskId`，使用 `get_task`
查询状态及结果。提交时提供唯一 `requestId`，只有完全相同的重试才能复用。Agent 使用项目已有对话
及积分；构建和发布不调用模型。`cancel_task` 可取消排队操作和运行中的 Agent；应用操作开始执行后
不能取消。这些功能需要现有 PostgreSQL、Redis、Worker 和沙箱配置。任务可跨 Web 重启恢复，
Worker 中断的执行会明确标记，而不会自动重复发布。

`read_file` 和 `list_files` 返回源码版本，`write_file` 必须传入 `expectedVersion`。
并发修改产生版本冲突时需重新读取。文件访问拒绝路径穿越、符号链接、内部指令及凭据文件。

在**账户设置 → 已授权的 MCP 客户端**中查看及撤销授权。撤销立即阻止新调用和令牌刷新；
已接受的任务继续运行，可在 Lovbase 中停止。访问令牌有效期为 1 小时，轮换的刷新令牌为 30 天，
授权请求为 10 分钟，一次性授权码为 5 分钟。数据库只保存令牌摘要，重放刷新令牌会撤销对应授权。
审计仅记录身份、操作、目标和结果，不记录令牌、SQL 正文或源码。数据库通过现有启动迁移自动建表。
该功能不会自动修改本机客户端配置。

升级时先暂时关闭入站 MCP，更新 Web 和所有 Worker 进程后再开启。应用操作使用独立的 `app-operations` 队列，原有 Agent 继续使用 `turns` 队列。OAuth 按连接对端限制请求：注册每分钟 30 次，授权、令牌交换及撤销每分钟各 300 次；反向代理后这些额度共享，工具另有账户级限流。
