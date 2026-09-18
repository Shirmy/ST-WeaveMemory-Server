# 织忆（WeaveMemory）Server

SillyTavern 长期记忆、人物状态与剧情脉络管理插件的服务端插件。负责状态链、状态增量、Checkpoint、长期记忆、检索和数据迁移。

## 当前进度（v0.1.0，Phase 0～3 已完成）

- Phase 0：`/health` 版本握手、`/generation/prepare` 生成前闸门、`/floor/finalize` AI 楼登记、每聊天串行任务队列、正文 fingerprint
- Phase 1：SQLite 持久化（`sqlite3` 5.1.7，Phase 1 验收标准为 Windows 无需手动编译依赖）、migration runner（当前数据库 schema 版本 3）、WAL、事务封装、启动时每日备份与 migration 前备份（最多保留 5 份）
- Phase 2：FloorVariant / swipe 身份、`/chat/reconcile`、active floor 集合、stale 标记、内部 branchId、`/branch/create`、`/branch/activate`、`/host-chat/bind`（SillyTavern 原生 Branch 绑定与重启恢复）
- Phase 3：谱 / 迹 / 事 TypeScript 类型、JSON Schema、运行时 Validator / Normalizer、lockedPaths、手动编辑协议、候选状态（Deep Partial）协议（`src/state/schema.ts`，状态协议版本 1）

尚未实现：状态模型调用（Phase 4）、状态节点 / 重放（Phase 5）及之后阶段。当前 `/generation/prepare` 恒返回 ready 且注入内容为空；`/floor/finalize` 只登记楼层，不触发状态分析。

## 数据目录

数据库位于 SillyTavern 用户数据目录：`<DATA_ROOT>/weavememory/weavememory.sqlite`，备份在同目录 `backups/`。数据库不放在插件代码目录内，插件更新不会覆盖用户数据。

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
```

## 安装提示

SillyTavern 需要启用 Server Plugins。插件路由会挂到 `/api/plugins/weavememory/*`。
