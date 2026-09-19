# Lovbase

**一句话生成真实的 Postgres 数据库和可用的应用,改需求时已有数据一行不丢。**

> ⚠️ 闭源开发阶段,MVP 验证中。

## 核心机制

自然语言 → 带稳定 ID 的 IR → 确定性 diff → 白名单 DDL → 真实 Postgres。

- LLM 从不直接写 SQL;它只产出 IR(`core/src/ir.ts`),由确定性代码编译
- 改名被识别为 `RENAME`(靠稳定 ID),不是删表重建
- 破坏性变更(删表/删列/改类型)必须由 workspace 主人在界面确认
- 每个项目一个独立 Postgres schema(`p_<id>`)+ 一个只有 DML 权限的角色(`ws_<id>`)

## 产品面

| 路由 | 说明 |
|---|---|
| `/` | 首页:提示框直接开建 + 项目列表(每个套餐的项目数上限在 `core/src/plans.ts`) |
| `/p/:id` | Builder:Agents / Preview / Database / Code 四个 tab |
| `/s/:token` | 分享链接:无需登录,可查看和录入数据,不能改结构 |
| `/settings` | BYOK:自己的 OpenAI 兼容端点 + key(AES-GCM 加密存储) |

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
docker compose up -d                 # Postgres :5433
cp .env.example app/.env             # 填 LLM_* 或 ANTHROPIC_API_KEY;SQL_ROLE_PASSWORD 随便设
bun install
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # 生成应用用的沙箱镜像,一次
bun run runner                       # 沙箱 runner :8788(本地 Docker 起容器)
bun run dev                          # rspack 监听 api/ + vite dev,localhost:3000
bun run lint                         # oxlint(含分层规则)
bun run typecheck                    # api 的类型检查;app 用 bun run --cwd app typecheck
bun run test                         # core 引擎 + 后端单测
```

`bun run dev` 会先把 `api/` 打一次包,再并行跑 rspack watch 和 vite——后端是编译产物,前端从 `@lovbase/api`
引它。改后端代码时 rspack 重新打包,vite 会跟着重载。

启动时自动建表、建 `lovbase_sql` 执行角色;要求 `DATABASE_URL` 的账号有 CREATEROLE。
环境变量在 `api/src/config/config.service.ts` 里集中声明并在启动时校验一次,填错的变量在启动就报错,
不会等到某条代码路径跑到才 500。

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
docker compose -f docker-compose.private.yml up -d                     # app + postgres + sandbox-runner
```

主应用镜像就是根目录的 `Dockerfile`。Postgres、统计事件、pi、模型 key 全在内网;模型走 BYOK 或内网网关。

## 部署:Railway 跑主应用,Cloudflare 跑沙箱

主应用是一个普通的 Node 进程:`app/server.mjs` 先挂 NestJS(`/api/*`、`/ingest/*`),再托管静态资源,
其余交给 TanStack Start。一个进程一个端口,后端和界面共用一个 DI 容器、一套连接池。
它和 Postgres 部署在同一个地方,所有数据库访问都是内网。沙箱留在 Cloudflare:一个 app 一个容器、
预览域名路由、闲置休眠、R2 静态托管都是平台给的。两边通过 HTTP 互调。

后端也能单独跑(`bun run --cwd api start`,即 `api/src/main.ts`)。要拆成两个服务时,
改的是部署方式,不是代码——`app/src/functions/_ctx.ts` 是唯一需要换成 HTTP 调用的地方。

### 1. Railway:主应用 + Postgres

新建项目,加一个 Postgres 服务,再从这个仓库建一个服务(根目录 `Dockerfile`,`railway.toml` 已配好)。
Railway 的区域选离 Cloudflare 容器近的,沙箱回调主应用的那条链路会短一些。环境变量:

```
DATABASE_URL            Postgres 的私网连接串(账号要有 CREATEROLE)
SQL_ROLE_PASSWORD       强密码;首次启动自动建 lovbase_sql 角色
BETTER_AUTH_SECRET
BETTER_AUTH_URL         https://你的域名
SANDBOX_URL             第 2 步部署出来的地址(https://lovbase.app)
SANDBOX_INTERNAL_TOKEN  和沙箱 Worker 的 INTERNAL_TOKEN 一致
ADMIN_EMAILS
LLM_BASE_URL LLM_API_KEY LLM_MODEL   平台默认模型;Pro 用户可以 BYOK
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

- **额度系统**:一次对话 1 额度,一次 Boris 生成界面 5 额度。免费用户每月 30 额度,
  等于最多 6 次生成界面。这是每个用户的成本天花板,也是最有效的一道。
- **`max_instances`**(`sandbox/wrangler.jsonc`):同时最多跑几个容器。容器按 vCPU 秒和内存秒计费,
  是唯一会自己跑掉的开销,这个数字就是硬上限。
- **`SANDBOX_SLEEP_AFTER`**:空闲容器多久回收,默认 5 分钟。正在看预览的用户会不断续期,
  所以调短是安全的,代价是重新打开旧预览要冷启动。

容器规格也能降,`instance_type` 从 `standard-1` 往下还有 `basic`、`dev`、`lite`,
但 Boris 要跑 bun install 和 vite,降之前先在测试项目上验证。

**想要账单完全封顶**:别用 Cloudflare Containers,把沙箱换成自带的 Docker runner,
跑在一台固定价格的服务器上(`docker-compose.runner.yml`),主应用的 `SANDBOX_URL` 指过去即可。
代价是没有发布静态站的能力,预览要自己配通配子域。

### 4. 收款(可选)

配好 Stripe 的 key 和四个 price id 后,把 webhook 指向 `https://你的域名/api/billing/webhook`。
没配这些时升级按钮只记录意向,不会扣款。

## 结构

四个包,按部署单元拆:`core` 是纯函数引擎,`api` 是后端,`app` 是界面,`sandbox` 是跑生成应用的服务。

```
core/src/             IR + 基于稳定 ID 的 differ + 白名单 DDL 生成器。纯函数,谁都能依赖
core/src/plans.ts     套餐、价格、额度成本(前后端共用的唯一定义)
core/src/templates.ts 首页模板(前端展示 + 后端建 demo 共用)

api/                  NestJS 后端。可以内嵌进 app 进程,也可以 `node dist/main.js` 单独跑
  src/config/         所有环境变量在这里声明 + 启动时校验一次
  src/database/       两个进程级连接池 + 建表
  src/common/         领域错误、Express⇄fetch 桥、全局鉴权守卫(@Public 才放行)
  src/modules/        auth · projects · apps · modeling · data · sql · roles · credits
                      billing · llm · sandbox · agent · analytics · demo · ingest · limits
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
/api/billing/webhook  Stripe 订阅事件
```

## 额度与套餐

一次 agent 对话消耗 1 额度,让 Boris 生成界面消耗 5 额度。额度按套餐每期发放,
管理员可在 /admin 单独赠送。套餐、价格、额度与上限只在 `core/src/plans.ts` 里定义一次。

支付走 Stripe Checkout,完全由环境变量开关:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...      STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_BUSINESS_MONTHLY=price_... STRIPE_PRICE_BUSINESS_YEARLY=price_...
```

没有配置时升级按钮只登记意向,不会收款。
