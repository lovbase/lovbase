# 排队调度与容器保温规划

## 1. 背景与目标

Lovbase 已经把进行中的对话流写入 Redis Stream：

- PostgreSQL 保存对话历史和运行状态；
- `lb:run:{runId}:chunks` Redis Stream 保存短期可重放的 UI 消息流；
- 浏览器刷新后可以从 Redis Stream 重新接入，Stream 缺失时回退到 PostgreSQL 中已保存的对话。

下一步使用 Redis + BullMQ 承担任务排队和跨进程调度。目标是：

1. API 收到消息后可靠入队，不再要求收到请求的 Web 进程亲自执行完整对话；
2. 多个 Worker 可以并行工作，但同一项目不能同时执行两个修改任务；
3. Cloudflare/Docker 沙箱的并发容量有统一、原子的控制；
4. 排队、执行、取消、失败和恢复在刷新页面后仍然可见；
5. 任务结束后给用户一段连续编辑的时间。用户仍在编辑对话框时保留容器；停止编辑后，由静态快照接替预览，再停止容器并归还槽位；
6. 容器已释放后，下一次提交新对话时再启动容器并恢复源码。

本规划不把 Redis 当成业务事实的唯一来源。Redis 负责调度、短期流和临时租约；PostgreSQL 继续保存任务、对话、计费和应用状态。

## 2. 关键决策

### 2.1 使用 BullMQ，不手写 Redis List 队列

引入 `bullmq`，复用现有 `REDIS_URL`。BullMQ 提供任务领取、延迟任务、锁续期、失败记录和 Worker 并发控制。生产环境继续使用 `maxmemory-policy noeviction`，避免 Redis 在压力下悄悄驱逐队列或运行流。

初期允许 BullMQ 与运行流共用一个 Redis 服务，但必须使用独立命名空间和连接：

```text
lb:q:*                         BullMQ 队列
lb:run:{runId}:chunks          现有 UI 消息 Redis Stream
lb:sandbox:*                   容器槽位和租约
lb:composer:{appId}            最近一次有效编辑活动
lb:app:{appId}:events          短期运行时事件（可选）
```

BullMQ 使用自身的 `prefix` 配置，不在 ioredis 连接上设置 `keyPrefix`。生产者连接应快速失败；BullMQ Worker 的阻塞连接按 BullMQ 要求配置重试。Redis Stream 的阻塞读取继续使用专用连接，不能和 BullMQ Worker 或普通命令共享。

容量或故障域需要隔离时，可以把 BullMQ 和运行流拆到两个 Redis 服务；键和服务边界不变。

### 2.2 PostgreSQL 是任务状态的事实来源

新增 `lb_jobs`，BullMQ 的 job payload 只携带 `jobId`，Worker 从 PostgreSQL 读取真正的输入。模型密钥不会进入 BullMQ。

建议字段：

```sql
CREATE TABLE public.lb_jobs (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  run_id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.lb_apps(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  status text NOT NULL,
  input jsonb NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  worker_id text,
  error text,
  cancel_requested_at timestamptz,
  enqueued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`input` 保存执行所需的不可变请求快照或稳定引用，例如消息 ID、模型档位、附件 URL 和提交时的对话版本。不要在 Worker 开始时直接读取“当前最后一条消息”来猜任务输入，否则排队期间的编辑会改变任务含义。

状态机：

```text
queued
  -> waiting_capacity
  -> starting
  -> running
  -> finalizing
  -> succeeded

queued/waiting_capacity/running -> cancelling -> cancelled
任意执行状态                    -> failed / interrupted
```

为 `queued`、`waiting_capacity`、`starting`、`running`、`finalizing` 建立“同一项目最多一个活动任务”的部分唯一索引。这样约束由数据库保证，而不是由某个 Web 进程中的内存状态保证。

BullMQ 可能至少执行一次，不能假设严格只执行一次。Worker 开始时必须用条件更新领取任务：只有预期状态才能进入下一状态。计费、最终快照和结束操作都要使用稳定幂等键。

### 2.3 解决 PostgreSQL 与 Redis 之间的双写

API 在一个 PostgreSQL 事务中：

1. 保存用户消息；
2. 创建 `lb_jobs`；
3. 创建或更新 `lb_runs`，写入稳定的 `runId`；
4. 提交事务。

事务提交后调用 `queue.add('turn.execute', { jobId }, { jobId })`。如果 Redis 暂时不可用，任务仍留在 PostgreSQL 的 `queued` 状态。一个轻量 reconciler 周期性扫描 `queued AND enqueued_at IS NULL` 的任务并重新投递。BullMQ `jobId` 与 `lb_jobs.id` 一致，因此超时后的重复投递不会创建第二份任务。

只有确认 `queue.add` 成功后才写 `enqueued_at`。如果写回失败，reconciler 会再次投递同一 `jobId`，结果仍然幂等。

## 3. 运行架构

建议两个 BullMQ 队列：

```text
turns
  turn.execute              执行完整对话

maintenance
  container.release         保温期结束后的快照切换、停机和槽位归还
  container.reap            回收失联 Worker 留下的租约
  jobs.reconcile            补投 PostgreSQL 中尚未进入 BullMQ 的任务
```

从第一阶段开始就拆成两个独立 Service，不提供 Web/Worker 同进程的 `all` 模式：

```text
Web Service
  接收请求、鉴权、写 PostgreSQL、投递 BullMQ、提供 SSE/状态查询
  不注册 BullMQ consumer，不执行模型循环，不直接持有容器租约

Worker Service
  消费 turns/maintenance、执行 TurnService、管理容器租约和快照
  不对公网提供产品 HTTP 流量
```

两个 Service 使用同一仓库和构建产物，但使用不同启动入口，例如 `start:web` 和 `start:worker`。本地开发命令也同时启动两个独立进程，尽早暴露跨进程通信问题。Railway 从第一次部署起就创建 Web Service 与 Worker Service；两者共享 PostgreSQL、Redis、对象存储和沙箱服务，只有 Web Service 绑定公网域名。

### 3.1 提交和观看任务

提交消息后的时序：

```text
浏览器
  -> Web：保存消息和 lb_jobs
  -> BullMQ：投递 turn.execute
  <- Web：返回 jobId/runId 和 queued 状态

Worker
  -> PostgreSQL：领取任务
  -> Redis：申请或复用容器槽位
  -> 沙箱：启动容器并恢复源码
  -> TurnService：执行模型循环
  -> Redis Stream：写 UI 消息流
  -> PostgreSQL：按现有节流保存对话、进度和计费
```

现有 `lb:run:{runId}:chunks` Stream 继续只承载 AI SDK 的 UI 消息流，不把 BullMQ 的内部事件混入其中。排队状态从 `lb_jobs` 读取：页面显示“排队中”“等待构建资源”“正在启动”“执行中”。一旦 Worker 开始产生回复，现有 Stream 重放接管内容展示。

Web 进程不持有任务执行权。浏览器连接断开只会失去一个读取者，不会取消 BullMQ 任务。

### 3.2 跨进程取消

当前 `TurnService.abort()` 只能中断本进程中的任务。拆出 Worker 后，停止按钮改为：

1. PostgreSQL 原子写入 `cancel_requested_at`；
2. 若任务仍在 BullMQ 等待队列，移除任务并标记 `cancelled`；
3. 若任务正在执行，通过 Redis Pub/Sub 或 BullMQ 辅助消息通知所属 Worker；
4. Worker 中断 `AbortController`，停止沙箱 Agent，封闭未完成的工具步骤；
5. 保存已有对话和实际用量，释放或转入容器保温流程；
6. 最终写入 `cancelled`。

Worker 仍需在工具步骤之间检查数据库中的取消标记，Pub/Sub 只用于降低取消延迟，不能成为唯一信号。

### 3.3 重试原则

整轮对话不设置盲目的多次自动重试。模型调用或文件写入可能已经产生副作用，Worker 在确认结果前崩溃时重新执行会重复写文件或扣费。

自动重试仅用于可证明尚未开始副作用的阶段，例如：

- 从 PostgreSQL 读取任务；
- Redis 临时连接失败；
- 尚未启动模型和工具前的容器容量等待。

已经开始模型循环或工具调用的任务，进程失联后标记 `interrupted`，保留已保存的对话和文件，让用户从当前结果继续。每笔计费使用 `jobId + chargeKind + sequence` 的唯一键，杜绝重复扣费。

## 4. 容器槽位与租约

BullMQ 的 Worker `concurrency` 不能代替容器容量控制：任务结束后容器还会保温，此时 BullMQ job 已经结束，但槽位仍被占用。

新增 `SandboxLeaseService`，在 Redis 中管理固定数量的槽位。建议结构：

```text
lb:sandbox:slots
  slot 1 -> appId, jobId, generation, state, leaseUntil
  slot 2 -> ...
  ...

lb:sandbox:app:{appId}
  slotId
  ownerJobId
  generation
  state = busy | warm | releasing
  leaseUntil
  warmUntil
  lastComposerActivityAt
```

申请、复用、续租和状态转换通过 Lua 脚本原子执行。

规则：

1. 同一 app 已有 `warm` 租约时，新任务直接接管该槽位并变为 `busy`；
2. 没有现成租约时，从空闲槽位中领取一个；
3. 没有槽位时，任务进入 `waiting_capacity`，按入队时间公平等待；
4. Worker 每 10 秒续租，建议租约 TTL 为 45 秒；
5. 租约过期不能直接分配给别人。reaper 必须先停止旧 app 的容器，再释放槽位；
6. 每次重新分配增加 `generation`。启动、写文件、停止等沙箱控制请求最终都应携带 generation，沙箱拒绝旧 generation 的操作，防止失联 Worker 复活后继续写入。

Cloudflare 的 `max_instances` 仍是最后一道硬上限。Redis 槽位数必须小于等于它，推荐两者都设为 5。现有 `MAX_ACTIVE_BUILDS` 将被 `SANDBOX_SLOT_COUNT` 取代，或仅在迁移期作为兼容别名。

任务 Worker 的并发可以高于槽位数，让普通队列处理、取消和状态更新不会被五个容量等待阻塞；真正启动模型前必须先取得当前 app 的槽位。第一版可设 Worker 并发 20、沙箱槽位 5，并监控等待 Worker 数量。

## 5. 任务结束后的容器保温

### 5.1 默认时间

新增配置：

```text
CONTAINER_WARM_GRACE_SECONDS=120
SANDBOX_LEASE_TTL_SECONDS=45
SANDBOX_LEASE_RENEW_SECONDS=10
SANDBOX_SLOT_COUNT=5
```

默认保温 120 秒。它足以覆盖用户查看结果后立即补充一句话的常见操作，又不会让无人继续的容器长期占槽。

`SANDBOX_SLEEP_AFTER` 必须大于保温时间并留有调度余量，建议至少 5 分钟。当前 Cloudflare 配置为 3 分钟、本地 runner 默认 30 秒，实施时必须统一调整到 5 分钟，否则容器可能在 BullMQ 的释放任务之前自行睡眠，造成“槽位仍占用、容器已经不在”的状态分裂。

### 5.2 什么算“仍在编辑”

只有对话框内容发生实际变化才续温：

- 输入或删除文字；
- 添加或删除附件；
- 编辑一条准备重新发送的历史消息。

仅仅保持页面打开、输入框获得焦点、鼠标移动或观看预览不续温。这样后台标签页和空白输入框不会无限占用容器。

客户端对编辑活动做 3 秒防抖，调用新的 `composerActivity({ projectId, appId })`。服务端鉴权后更新：

```text
lb:composer:{appId} = lastActivityAt
TTL = warm grace + 60 秒
```

如果 app 当前处于 `warm`，活动同时把 `warmUntil` 推迟到 `lastActivityAt + 120 秒`，并更新 BullMQ 延迟释放任务。活动接口不会在容器已经停止时重新启动它；冷容器只在用户真正提交下一轮对话后启动。

为防止沙箱平台自身的 idle timer 在用户连续编辑期间先于调度器休眠，`SandboxLeaseService` 在收到有效编辑活动时对仍然存在的 warm 容器执行限频 keepalive，最多每 30 秒一次。keepalive 必须校验租约和 generation，不能因为一个过期浏览器请求重新唤醒已经释放的容器。

### 5.3 保温状态机

```text
任务执行：busy
  |
  | 任务结束，源码已持久化
  v
生成或确认静态快照：finalizing
  |
  | 快照版本 >= 源码版本
  v
保温等待：warm（默认 120 秒）
  |\
  | \ 用户提交新对话：取消释放任务，复用容器 -> busy
  |
  | 用户继续编辑：warmUntil 后移
  |
  \ 到期且没有新活动
     -> 静态快照成为权威预览
     -> 停止容器
     -> 归还槽位
     -> cold
```

任务结束时创建 BullMQ 延迟任务：

```text
name: container.release
jobId: release:{appId}:{generation}
delay: warmUntil - now
payload: appId, slotId, generation, expectedSourceVersion
```

不要依赖 Web/Worker 进程中的 `setTimeout`。进程部署或崩溃后，BullMQ 延迟任务仍然存在。

编辑活动发生时可以使用 `changeDelay()` 延后仍处于 delayed 状态的任务。无论是否成功修改，释放 Worker 执行时都必须重新读取租约和最后编辑时间；旧任务、旧 generation 或尚未到期的任务只能退出或重新调度，不能停止容器。

### 5.4 静态快照接替预览

当前 `AgentService.finishBuild()` 已能构建静态快照、标记 `snapAt` 并生成封面，但调用方是 best-effort fire-and-forget。实施时将其拆成幂等的 finalization 操作，并明确追踪版本：

```text
sourceVersion      每次源码快照持久化后递增
snapshotVersion    静态构建成功时记录对应 sourceVersion
```

释放容器前必须满足 `snapshotVersion >= sourceVersion`。建议流程：

1. 对本轮修改后的源码做最终持久化；
2. 构建静态快照并记录 `snapshotVersion`、`snapUrl`、`snapAt`；
3. 容器进入 warm，用户可以继续看实时预览和热更新结果；
4. 保温到期后再次核对源码版本和快照版本；
5. 将 app 的运行时预览状态切换为 `snapshot`，向前端发布 `snapshot_ready`；
6. 给已连接页面一个很短的切换窗口，然后停止容器；
7. 释放 Redis 槽位。

前端收到 `snapshot_ready` 后，使用现有 `snapUrl` 替换 live preview iframe。运行流在任务结束后已经关闭，因此这个事件不应写进 `lb:run:{runId}:chunks`；可以增加 app runtime SSE，也可以在实时预览期间低频轮询 app runtime 状态。第一版建议低频轮询，页面可见且显示 live preview 时每 10 秒查询一次，收到 `snapshot` 状态立即切换；以后需要更即时再加 Redis Pub/Sub 驱动的 SSE。

如果快照构建失败：

- 延迟释放任务最多重试 3 次，使用指数退避；
- 重试期间租约保持 `releasing`，但不接受新 app 写入；
- 新对话到来时可取消释放并把租约恢复为 `busy`；
- 重试耗尽后，为避免永久占槽，停止容器并释放槽位，前端明确显示“静态预览生成失败，可重新启动预览”，而不是继续假装 live URL 可用。

### 5.5 下一轮对话

移除“输入框获得焦点就启动容器”的行为。焦点或编辑活动只负责延长一个已经 warm 的容器，不会从 cold 状态启动容器。

下一次用户提交消息后：

1. 创建并入队任务；
2. 任务取得槽位，或复用同一 app 尚在保温的槽位；
3. 若容器已停止，则启动容器并从 `lb_app_files` 恢复源码；
4. 启动预览；
5. 再开始模型循环，确保 Agent 第一次文件工具调用面对的是完整源码。

新项目当前会在创建后立即调用 `AgentService.prepare()`，也应改为由首轮对话的队列任务启动，避免只创建项目却不发送消息的用户占用容器。

## 6. 公平性与背压

第一版采用以下规则：

- 同一项目最多一个排队或执行中的任务；
- 同一用户最多 3 个排队任务；
- 等待新槽位时按 `created_at` 先进先出；
- 同一 app 的 warm 容器允许会话亲和复用，不回到全局队尾重新争抢槽位；
- warm 仅由真实编辑活动延长，停止编辑 120 秒后必然进入释放流程；
- 管理员可以暂停队列、调整槽位数，但不能把 Redis 槽位数调到 Cloudflare 硬上限以上。

如果后续出现单个用户长期占满容量，再增加按用户轮转或套餐优先级。第一阶段先记录数据，不预先引入复杂的优先级策略。

## 7. 前端变化

聊天区增加明确状态：

```text
排队中 · 前面还有 N 个任务
等待构建资源
正在启动预览
正在执行
正在保存静态预览
已切换到静态预览
任务已取消 / 中断 / 失败
```

需要调整：

1. `useChat` transport 提交后拿到稳定的 `jobId/runId`；
2. `chatState` 同时返回 job 状态、排队位置（可获得时）和运行开始时间；
3. queued 状态允许取消，取消后不会启动模型或容器；
4. 刷新页面后先恢复 job 状态，再接入现有 Redis Stream；
5. `Composer` 暴露实际内容变化事件，3 秒防抖上报编辑活动；
6. 删除现有 focus prewarm；
7. live preview 低频读取运行时状态，快照接管后切换到 `snapUrl`。

排队位置只能作为近似值：前面的任务可能取消、复用 warm 容器或不需要完整构建，不承诺准确的等待时长。

## 8. 可观测性

结构化日志至少包含：

```text
jobId, runId, projectId, appId, userId
queueWaitMs, capacityWaitMs, startMs, runMs, finalizeMs
slotId, leaseGeneration, warmMs
result, attempt, cancelSource, errorClass
snapshotVersion, sourceVersion
```

指标：

- queued / waiting_capacity / running 任务数量；
- p50/p95 排队时间和容量等待时间；
- 容器槽位 busy、warm、releasing、free 数量；
- warm 容器复用率；
- 因编辑活动延长的保温次数和时长；
- 静态快照成功率、耗时和重试次数；
- Worker 失联、租约回收、重复投递和幂等命中次数；
- Redis Stream 录制失败与回退到 PostgreSQL 的次数。

告警：

- 队列最老任务等待超过阈值；
- Redis 槽位数与实际活跃容器数不一致；
- `releasing` 状态持续时间异常；
- Redis 内存接近上限或出现写入拒绝；
- Worker 数量为零但队列非空。

## 9. 分阶段实施

### 阶段一：持久任务与 BullMQ

- 安装 `bullmq`，确认与当前 `ioredis`、Bun 和 Node 构建产物兼容；
- 新增 `lb_jobs`、唯一约束和 job repository；
- 增加 `turns` 与 `maintenance` 队列、生产者、Worker 和 QueueEvents；
- 新增独立的 Web 与 Worker 启动入口，Web 进程不注册 consumer；
- 本地开发同时启动 Web、Worker 两个进程；
- Railway 直接创建 Web Service 与 Worker Service，只有 Web Service 暴露公网端口；
- 实现事务后投递与 reconciler；
- 将 `ChatController -> TurnService.start()` 改为创建任务；
- Worker 调用现有 TurnService；
- 保留当前 Redis Stream 捕获与重放协议。

### 阶段二：跨进程运行与取消

- `TurnService` 不再依赖 Web 进程内存作为主要读取路径；
- 实现 job 状态查询、刷新恢复和跨进程取消；
- 部署时分别 drain Web 与 Worker：Web 停止接新请求，Worker 停止领取新任务并等待活动任务完成。

### 阶段三：容器槽位

- 实现 Redis Lua 原子槽位操作和租约续期；
- 所有可能启动容器的路径统一经过 `SandboxLeaseService`，包括对话、手动打开 live preview、发布和旧 `edit_app`；
- 增加 generation 校验和失联租约 reaper；
- 替换现有基于 `lb_runs.progress` 的 `MAX_ACTIVE_BUILDS` 计数。

### 阶段四：编辑续温与快照接管

- 增加 composer activity 上报；
- 增加 BullMQ 延迟释放任务；
- 增加 source/snapshot version；
- 将 `finishBuild()` 变为可追踪、幂等的 finalization；
- 前端从 live preview 切换到静态快照；
- 删除 focus prewarm，并让下一轮对话负责启动 cold 容器。

### 阶段五：生产调优

- 根据实测调整 Worker concurrency、120 秒保温时间和用户排队上限；
- 评估是否需要将 BullMQ 与运行流拆分到不同 Redis 服务；
- 根据实际等待分布决定是否引入套餐优先级或按用户轮转。

## 10. 测试与验收

### 10.1 队列

- 同一个 `requestId` 重复提交只执行一次；
- Redis 在 PostgreSQL 提交后短暂不可用，恢复后任务会由 reconciler 投递；
- 两个 Worker 竞争同一任务时只有一个能进入 `running`；
- 同一项目的第二个任务被拒绝或保持 queued，不会并行写代码；
- 刷新页面可以恢复 queued、waiting_capacity 和 running 状态；
- 排队任务取消后不会调用模型、扣费或启动容器。

### 10.2 Redis Stream

- BullMQ 引入后，现有 Stream 顺序、显式 ID、TTL、大小上限和断线重放测试继续通过；
- Worker 与 Web 分处不同进程时，Web 可以从 Redis Stream 实时读取 Worker 产生的输出；
- Stream 丢失或 Redis 故障时，对话执行继续，页面回退到 PostgreSQL 已保存内容。

### 10.3 容器容量

- 任何时刻实际运行/保温容器不超过 5 个；
- Worker 崩溃后，reaper 先停止旧容器再归还槽位；
- 旧 generation 的 Worker 不能写文件、续租或停止新容器；
- 同一 app 在 warm 状态提交新任务时复用原容器；
- 其他 app 在槽位耗尽时显示等待，不在 Cloudflare 内部静默排队。

### 10.4 保温与释放

- 任务结束后 120 秒内提交下一轮，不发生冷启动；
- 在对话框持续输入会延后释放；
- 只保持焦点或打开页面不会延后释放；
- 停止编辑 120 秒后，静态快照接替 live preview，随后容器停止、槽位归还；
- 旧的 delayed release job 不能停止一个已被新任务接管的容器；
- cold 状态下编辑文本不会启动容器，提交消息才启动；
- 快照失败会重试，重试耗尽后释放容量并显示明确状态。

### 10.5 发布验收

从第一次集成验证开始就分别运行 Web 和 Worker。发布前至少完成：

- 队列、Redis Stream、租约和延迟释放的 Redis 集成测试；
- Web 进程中不存在 BullMQ consumer，Worker 进程不承接公网产品请求；
- 两个 Worker 的并发测试；
- 真实 Docker runner 下的启动、复用、快照、停止流程；
- Railway 滚动部署期间的排队、执行、取消和恢复测试；
- Cloudflare `max_instances=5` 与 `SANDBOX_SLOT_COUNT=5` 的一致性检查。

## 11. 完成定义

当以下行为同时成立时，这项改造完成：

1. Web 实例重启不丢排队任务，浏览器断线不终止执行；
2. Worker 可以水平扩容，同一任务和同一项目不会重复执行；
3. Redis Stream 继续负责短期流重放，PostgreSQL 继续保存长期事实；
4. 容器容量由原子槽位租约控制，实际使用不超过平台硬上限；
5. 任务结束后，真实的对话框编辑活动能延长容器保温；
6. 用户停止编辑后，静态快照接管预览，容器停止并归还槽位；
7. 下一次新对话在任务开始时启动或复用容器，不因输入框获得焦点而提前占用容量；
8. 排队、等待容量、执行、取消、快照和释放都有可观察状态与覆盖关键竞态的测试。
