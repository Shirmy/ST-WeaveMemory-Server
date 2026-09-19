# Phase 16 修复验收记录

本轮仅处理 Phase 16。保留现有 drawer；未实现 Phase 17 导出 / 导入全库、恢复、完整数据重建。Prompt 预设导入 / 导出属于 §61 配置功能。“跟随 SillyTavern”继续延期。

## 参考依据

- 最终行为：`WeaveMemory_Full_Implementation_Roadmap_v1_updated.md` §0 / §4～15 / §51～61 / §91，以及本轮用户明确修正。
- 起点：Frontend `6aca6d3`，Server `aee7070`。
- 当前本地 SillyTavern release `06bde93`：`public/scripts/extensions.js` 的 `#extensionsMenu` / `#extensionsMenuButton`、可见子项检测与菜单创建。
- 构画 SevenDaysCal `43fd20f`：`api/client.js`、`runtime/settings.js` 与菜单实现。
- QQJ MyriadKnots `47c8ec1`：`src/v3/cse-runtime.js` 手动更正、最新 anchor 与 Delta。
- 柏宝书 BaiBai-Book `32dbb48`：`src/memory/apply.ts` 手动修改挂有效叶子、无叶子拒绝。

## 实现与调用路径

| 项目 | 正式实现 |
| --- | --- |
| 入口 | 前端 `src/ui/trigger.ts` 向 Extensions 菜单添加唯一子项；DOM ready / 最多 15 秒 MutationObserver，无无限轮询 |
| 契约 | 前端 `src/api/backend-client.ts`、`src/types.ts`；Channel / Binding / Prompt / Recall / Settings 均使用服务端字段 |
| Schema | 服务端 `src/state/schema.ts` 为源；前端 `src/state-schema.ts` 同步类型，`scripts/check-state-schema.mjs` 精确比对 |
| 手动修改 | `/state/manual-edit` → `StateTaskRunner.manualEdit` → `StateChainEngine.applyManualEdit` → 同楼新节点及事务 → memory stale → rebuild planning |
| 事务隔离 | `SqliteDatabase` 同一连接串行隔离事务与其它请求；失败回滚不影响其它聊天写入；队列错误由调用方接收，无派生未处理拒绝 |
| Summary Prompt | `AiConfigStore` 内置 / 用户 / active preset → `LongMemoryGenerator` → Batch 依赖哈希；修改启用 Prompt 与失效旧记忆一起提交 |
| 重总结 | `/memory/resummarize-range` → Scheduler 同步状态后读正式源楼 / Delta / 结束状态 → Generator 强制生成并回写前复验 |
| 召回设置 | `AiConfigStore` 持久化 → `MemoryRuntime` / `/recall/debug` → RecallService / Token Packer |
| Diagnostics | `src/core/diagnostics.ts` 最多 100 个 chat + branch 缓存；`/debug/current` 合并近期状态任务与数据库健康 |
| 文本安全 | 前端唯一 `src/ui/text.ts` 转义模板动态文本；toast 用 textContent；输入用 value，selector ID 用 CSS.escape |

旧 StateNode 的身份、状态内容与 fingerprint、旧 Delta / Checkpoint 均保持不变；状态同步仍可以变更节点的 synced / stale / inactive 标签。同楼新节点复制依赖与前一节点引用，重算前一快照到编辑快照的 Delta，创建独立 Checkpoint。下游重算为相同状态时仍复用旧后继节点并汇合。

`restore-ai` 仅清除字段手动来源和锁；无有效头拒绝，不制造 manual-root。候选及最终完整快照都校验，拒绝未知字段、非法枚举、越界 affinity 和危险属性路径。

## 自动化

新增 `test:phase16-api`、`test:manual-state-edit`、`test:prompt-summary`、`test:phase16-schema`，前端新增 `test:phase16-contract`。`test:prompt-summary` 复用 API 综合脚本，覆盖真实本地 mock HTTP 模型调用、预设激活、生成依赖变化、无正式测试写入。它不代表外部供应商或浏览器实机验收。

API 验收覆盖渠道 CRUD 与密钥保留 / 替换 / 清除、模型列表与测试响应、四个 role 同 / 异渠道及取消 / 删除解绑、两类 Prompt CRUD / 版本 / 激活 / 恢复 / 测试、总结 Prompt 真正进入生成、includeStale、禁用后恢复 BM25 / 向量召回、持久化预算、真实 recall / diagnostics、正式源构建重总结、非法手动 Schema 拒绝及失败后队列继续工作。

手动状态测试覆盖历史不变、新节点 / Delta 重放、新 Checkpoint、checkpoint / syncStatuses 故障回滚、并发事务隔离、锁定与恢复 AI 管理保值、N+1 失效与 N+2 convergence。

2026-09-20 实际执行结果：以下全部通过，无跳过或弱化既有断言。

- Server：`typecheck`、`lint`、`build`。
- Server：`test:persistence`、`test:floor-reconcile`、`test:branch`、`test:branch-fork`、`test:host-branch`、`test:state-schema`、`test:ai-config`、`test:ai-client`、`test:state-task`、`test:state-diff`、`test:state-chain`、`test:state-chain-1000`、`test:state-rebuild`、`test:generation-gate`、`test:current-state`、`test:recent-context`、`test:external-mapping`、`test:long-memory`、`test:long-memory-scheduler`、`test:long-memory-migration`、`test:long-memory-recovery`、`test:bm25`、`test:embedding`、`test:recall`、`test:token-packer`、`test:long-memory-injection`。
- Server 新增：`test:phase16-api`、`test:manual-state-edit`、`test:prompt-summary`、`test:phase16-schema`。
- Frontend：`typecheck`、`lint`、`build`、`test:external-state`、`test:generation-reason`、`test:phase16-contract`（含 Schema 同步检查）、`test:scope-events`（真实宿主事件模块配合 mock 宿主，验证慢响应 / 禁用时切聊天，不替代实机验收）。

1000 楼状态链实测构建 52.8 秒，完整 1000 Delta 重放 12.7 ms；BM25 1 万条验收平均 9.2 ms。这些是本次 Windows 测试环境数据，不是浏览器性能保证。测试日志中的 simulated embedding / rerank / database 故障为降级与阻止生成测试用例，不是未处理失败。

## SillyTavern 实机验收（未执行）

- [ ] 魔法棒可见“织忆”、打开 drawer、关闭 / Esc / 背景点击正常。
- [ ] enabled 开 / 关时切聊天都更新 scope，慢请求不覆盖新聊天；浏览器 console 无未捕获异常。
- [ ] 新建 / 修改 / 删除渠道，API Key 保留 / 替换 / 清除，headers / timeout 生效，测试与拉模型。
- [ ] summary / state / embedding / rerank 同渠道和不同渠道绑定、取消 rerank、删除渠道自动解绑。
- [ ] 两类 Prompt 编辑副本 / 保存 / 切换 / 恢复 / 导入 / 导出 / 测试，版本与实际模型输入一致。
- [ ] 人物来源、场景相关性与同步标记；谱 / 迹修改、lock / unlock / restore-ai；无首节点给业务提示。
- [ ] 现在、日历月 / 日视图、新增首个日期条目、剧情线 / 安排及人物 / 剧情线关联保存。
- [ ] 记忆搜索与人物 / 剧情线 / 日期 / 楼层过滤、来源范围、真实索引状态、禁用 / 启用、批次重总结、召回各阶段。
- [ ] 主 / 旧设置同值，近期原文 / 摘要正则、总结间隔、固定最近 N、召回和 Token 预算实际生效。
- [ ] Debug 显示近期准备注入、长期记忆 / 谱迹事、预计 Token、状态 / 总结耗时、召回耗时、状态链 / DB；缺数据为“暂无数据”。
- [ ] 长期记忆注入仍为 SYSTEM / IN_CHAT / depth 9999；准备结果与宿主实际注入分别核对。

当前没有浏览器实机通过证据，因此 Phase 16 尚不能标记最终 DONE。语言目前只提供简体中文；自动备份最近结果尚无查询数据，界面明确显示“暂无数据”；已有启动备份机制不变。
