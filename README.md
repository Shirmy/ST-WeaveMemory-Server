# 织忆（WeaveMemory）Server

SillyTavern 长期记忆、人物状态与剧情脉络管理插件的服务端插件。负责状态链、状态增量、Checkpoint、长期记忆、检索和数据迁移。

## v0.1.0 当前完成

- `/api/plugins/weavememory/health` 前后端版本握手
- `/api/plugins/weavememory/generation/prepare` 生成前闸门接口
- `/api/plugins/weavememory/floor/finalize` AI 楼完成接口
- 每聊天串行任务队列
- 楼层正文 fingerprint / swipe 身份骨架
- 存储接口抽象

当前 `MemoryStore` 暂用内存实现，**不会作为正式数据方案**。下一阶段接持久化数据库后再开放插件总开关，避免把试验数据当正式记忆。

## 为什么 v0.1 不直接塞 SQLite

SillyTavern 当前最低 Node.js 版本为 20。原生 SQLite 包在 Windows 上可能涉及 ABI / 预编译二进制兼容。先把存储接口与业务状态链解耦，再选择无痛安装的持久化驱动，避免在线更新时把用户卡在 native module 安装问题上。

## 开发

```bash
npm install
npm run typecheck
npm run build
```

## 安装提示

SillyTavern 需要启用 Server Plugins。插件路由会挂到 `/api/plugins/weavememory/*`。
