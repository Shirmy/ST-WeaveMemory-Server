# 织忆（WeaveMemory）Server

SillyTavern 长期记忆、人物状态与剧情脉络管理插件的服务端插件。负责状态链、状态增量、Checkpoint、长期记忆、检索和数据迁移。

## 当前进度（v0.1.0，Phase 0～10 已完成）

- Phase 0：`/health` 版本握手、`/generation/prepare` 生成前闸门、`/floor/finalize` AI 楼登记、每聊天串行任务队列、正文 fingerprint
- Phase 1：SQLite 持久化（`sqlite3` 5.1.7，Phase 1 验收标准为 Windows 无需手动编译依赖）、migration runner（当前数据库 schema 版本 3）、WAL、事务封装、启动时每日备份与 migration 前备份（最多保留 5 份）
- Phase 2：FloorVariant / swipe 身份、`/chat/reconcile`、active floor 集合、stale 标记、内部 branchId、`/branch/create`、`/branch/activate`、`/host-chat/bind`（SillyTavern 原生 Branch 绑定与重启恢复）
- Phase 3：谱 / 迹 / 事 TypeScript 类型、JSON Schema、运行时 Validator / Normalizer、lockedPaths、手动编辑协议、候选状态（Deep Partial）协议（`src/state/schema.ts`，状态协议版本 1）
- Phase 4：AI 渠道（OpenAI 兼容协议，API Key 本地加密存储）、四类模型角色绑定、Prompt 预设与 promptVersion、状态分析任务（重试 / 超时 / 取消 / 回写前按 dependencyFingerprint 复验楼层、前态与 Prompt / 重启恢复）、`/ai/*` 与 `/state/tasks*` 接口（`src/ai/`、`src/storage/ai-config-store.ts`、`src/storage/state-task-store.ts`）
- Phase 5：状态链。候选状态按 §8.3 语义合并进上一份快照，程序计算状态增量并落成状态节点，每 N 个节点一个 Checkpoint（默认 20），重放 = 最近 Checkpoint + 后续增量并校验指纹；Checkpoint 缺失、损坏或与节点指纹不一致时报 `WM_STATE_SYNC_FAILED`，当前快照缓存只有内容哈希等于节点指纹时才被采用；楼 N 必须基于楼 N-1 的有效节点分析，前楼无效则任务失败而不是凭空分析；重算得到相同状态或存在相同依赖的候选时直接复用、不调用模型；`/state/current`、`/state/at` 返回当前 / 历史快照。已通过 1000 楼真实入库的完整链恢复测试（`src/state/diff.ts`、`src/state/apply.ts`、`src/state/chain-engine.ts`、`src/storage/state-chain-store.ts`）
- Phase 6：重roll / 编辑 / 删除重建。节点有效性按依赖指纹（正文 + 前态指纹 + 协议 / Schema / Prompt 版本）在读取时计算，并同步回节点与楼层状态；reconcile 后与每次节点提交后自动做重建规划：取消前态已固定的在途下游任务，为第一个失效楼排队，重算得到相同状态即汇合停止；删楼平移、swipe 来回等相同正文按依赖指纹复用已存候选而不调用模型；Prompt 版本变化只标记不自动重算，`/state/rebuild` 可续跑或强制从某楼重建；分支尚无节点的聊天不自动回填，真实失败的楼不被自动重试（`src/ai/state-task-runner.ts` 的 planRebuild / rebuild，`src/state/chain-engine.ts` 的 trustedPrefix / syncStatuses）
- Phase 7：生成前状态同步闸门。`/generation/prepare` 检查上一 AI 楼的可信状态节点；pending / running 时等待，缺失、stale 或失败时触发一次补同步，最终失败或超时返回 `ready: false`；前端清理旧注入、提示用户并阻止正文生成（`src/core/runtime.ts`、前端 `src/host/generation.ts`）。
- Phase 8：当前状态筛选和 depth 1 注入。根据当前用户输入、最近 4 个 AI 楼、`事·现在` 关联人物和当前活跃剧情线选择相关人物，再筛选剧情线、日历与未来剧情安排；只注入相关人物的谱 / 迹，始终保留事·现在，并通过 `setExtensionPrompt()` 以 SYSTEM / IN_CHAT / depth 1 注入（`src/state/current-state.ts`）。
- Phase 9：近期上下文。支持原文模式和本地正则摘要模式，摘要逐楼提取失败时回退该楼正文，不调用额外 AI；近期楼数、模式和正则可在前端扩展设置中配置（`src/state/recent-context.ts`、前端 `src/ui/settings.ts`）。
- Phase 10：长期记忆生成。长期记忆总结间隔由服务端持久化配置控制（默认 30 个 AI 楼），Scheduler 按 N 个 AI 楼形成 Batch，Batch 内由模型按事件生成多个 Slice；Batch 保存真实 FloorVariant 来源、人物、剧情线、时间、结束状态指纹和依赖指纹；正文 / swipe / 删除导致来源楼变化时整个 Batch 标记 stale，状态链稳定后自动补洞；相同依赖的历史 Batch 可在模型调用前直接复用并重新激活；提供 `/memory/list` 和 `/memory/resummarize`（`src/memory/`、`src/storage/long-memory-store.ts`）。

尚未实现：Phase 11 及之后阶段；长期记忆 BM25、Embedding、召回、重排和注入仍未接入，`longMemory` 保持为空；「跟随 SillyTavern」渠道模式延后。

## 数据目录

数据库位于 SillyTavern 用户数据目录：`<DATA_ROOT>/weavememory/weavememory.sqlite`，备份在同目录 `backups/`。数据库不放在插件代码目录内，插件更新不会覆盖用户数据。同目录的 `secret.key` 是 API Key 的加密密钥，不随备份复制；丢失后需重新填写各渠道密钥。

## 开发

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

验收测试按 Phase 拆分：

```bash
npm run test:persistence
npm run test:floor-reconcile
npm run test:branch
npm run test:branch-fork
npm run test:host-branch
npm run test:state-schema
npm run test:ai-config
npm run test:ai-client
npm run test:state-task
npm run test:state-diff
npm run test:state-chain
npm run test:state-chain-1000
npm run test:state-rebuild
npm run test:generation-gate
npm run test:current-state
npm run test:recent-context
npm run test:long-memory
npm run test:long-memory-scheduler
```

`test:state-chain-1000` 会通过 mock 模型把 1000 个楼层真实写入 SQLite 再做恢复验证，运行约 40 秒。

## 安装提示

SillyTavern 需要启用 Server Plugins。插件路由会挂到 `/api/plugins/weavememory/*`。
