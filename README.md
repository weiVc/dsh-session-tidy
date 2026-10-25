# 会话整理 · Session Tidy

DeepSeek Harness 的轻量会话管理插件：**删除会话**，或**只删除会话里的某一轮对话**。所有删除都有二次确认，并直接落到宿主存储上——不是隐藏，不是归档。

> 作者：**大肥鲸** · MIT License · 适用于 DSH 0.2.x（v4 会话日志）

## 功能

| 位置 | 操作 |
|---|---|
| 左侧会话列表 → 会话行的「⋯」菜单 | **删除会话…**（红色）——永久删除该会话的日志、投影缓存与工作区登记 |
| 任意**已完成**轮次的末尾 | **删除本轮**（低存在感小按钮）——从会话日志中移除该轮的用户消息、步骤、工具调用与回答；后续轮次保留并顺延编号 |

对话中不会出现额外面板、页面或常驻按钮；删除入口只在需要的位置出现。

## 行为与安全

- **二次确认**：每个操作都先弹确认框，危险按钮使用错误色，忙碌时锁定。
- **先停后删**：对正在运行的会话，先通过宿主自己的 AgentHandle 取消本轮、等待静默、摘载 Agent，再动文件；插件安装前就已存在的 Agent 会退化为「取消 → 静默 → 卸 Agent 作用域 → 摘除 Session → 注销 Agent」并逐步校验。
- **真正的删除**：会话删除会移出日志目录（先隔离到 `~/.dsh/session-tidy-trash/` 再清除）、删除投影缓存行、从工作区顺序/归档/置顶中摘除。
- **单轮删除是日志改写**：DSH 的会话日志是 append-only 的，所以插件在宿主侧把日志解压 → 删除该轮事件区间（连同该轮排队输入的 add 事件，避免排队消息残留）→ 重映射后续 `seq` 与 `sourceEventSeqs` / `surfaceOp` / `headerSeq` / `throughSeq` / `messageSeqs` 引用 → 重新压缩写入；写前备份、写后**用官方 Session 重放全量校验**；任何无法安全重映射的引用（例如该轮之后存在压缩/图片卸载记录）都会**拒绝删除**并保持原样。
- **身份与路径校验**：会话目录 realpath 三级校验、日志 `header.id` 校验、拒绝 junction/符号链接指向的其它会话；有分叉/子代理会话的父会话必须先删除子会话。
- **备份**：每次单轮删除前，原始日志会存到 `~/.dsh/session-tidy-backups/`，便于人工恢复。
- **保守拒绝**：分叉会话（fork，含继承前缀）暂不支持删除单轮；正在运行的轮次不能删除；同一会话的并发删除会被拒绝。

## 限制

- 单轮删除只移除会话日志中的记录；已经产生的附件、`~/.dsh/spill/` 溢出文件、子代理会话、其它缓存不在清理范围内。
- 单轮删除会改动会话日志，可能使已打开的其它客户端窗口显示旧内容；当前窗口会自动重开该会话。极少数情况下需要刷新页面。
- 仅适用于官方 JSONL 会话存储（`@deepseek-ai/dsh-session-persistence-jsonl`）；其它后端会返回「不支持」而不是冒险删除。
- 删除不可恢复（除单轮备份外）。

## 安装

```sh
dsh plugin --profile desktop add dsh-session-tidy
```

也可以在 Harness 的「插件 → 添加插件」里直接输入包名安装。安装后通常无需重启即可在页面生效（若宿主提示 `restart-required`，重启 DSH）。

开发调试可用本地目录：

```sh
dsh plugin --profile desktop add link:/absolute/path/to/dsh-session-tidy
```

## 卸载

```sh
dsh plugin --profile desktop remove dsh-session-tidy
```

卸载不会删除任何会话；`~/.dsh/session-tidy-backups/` 可自行清理。

## 测试

```sh
node --test host/log.test.mjs
```

合成日志用例始终运行；使用真实会话日志的用例需要一份私有 fixture（不随插件分发、避免泄露会话内容）：

```powershell
$env:DSH_TIDY_FIXTURE="C:\path\to\session.v4.jsonl.zstd"; node --test host/log.test.mjs
```

## 结构

```
index.js               Host：HTTP 路由、生命周期、删除流程
host/log.js            zstd 会话日志解码/编码 + 单轮删除计划（纯函数）
host/log.test.mjs      node --test
host/delete-session.js 路径解析、AgentHandle 追踪、目录隔离删除、原子写入、备份
client.js              Web 客户端：菜单项 / 轮次按钮 / 确认框
locale/{zh,en}.json    插件元数据
icon.svg               插件图标
```

## 致谢

设计时参考了社区同类插件的行为与边界（未复制其代码）：

- [dsh-chat-manager](https://www.npmjs.com/package/dsh-chat-manager)（会话删除的日志/投影缓存/工作区一致性、AgentHandle 追踪）
- [dsh-session-clean](https://www.npmjs.com/package/dsh-session-clean)（会话行菜单入口）
- [@morlay/ui-conversation-message-actions](https://www.npmjs.com/package/@morlay/ui-conversation-message-actions)（recall/rewind 的边界语义）
- [DeepSeek Plugin 目录 · 会话与消息](https://deepseekplugin.com/zh/plugins/category/sessions-messages)
