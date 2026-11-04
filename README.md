# dsh-xiaofei-memory

一个无头、异步、具备新陈代谢与自我进化能力的长期记忆引擎，是 DeepSeek Harness (DSH) 的函数式插件。它不干涉对话逻辑与角色路由，只作为底层的"数字海马体"，提供极速、精准、带权重的记忆读写服务。

> 技术栈：TypeScript 风格 ESM JavaScript + `node:sqlite`（需 Node ≥ 22.13.0，零运行时第三方依赖）。

## 核心架构（双轨异步）

| 轨 | 事件 | 职责 |
|---|---|---|
| **主轨（读）** | `agent/pre-step` (waterfall) | 清洗 Query → 混合检索 + 权重重排 → 注入 `<memory-recall>` 上下文 |
| **旁轨（写）** | `session/event` `turn/end` | 旁路异步抽取 → 融合去重 → 落库 SQLite（`queueMicrotask`，不阻塞主对话） |
| **后台（代谢）** | 每日凌晨 `sleepTimeHour` | 夜间睡眠：摘要提纯 + 废弃归档 + VACUUM + FTS optimize + 参数自适应进化 |

## 数据存储

默认路径：`$DSH_HOME/plugin-data/dsh-xiaofei-memory/memory.sqlite`（可用 `dbPath` 覆盖），WAL 模式。

- `memories` 主表：`role_id`（命名空间）、`layer`（core/weekly/recent）、`content`、`entities`、`origin_ids`（溯源）、`strength`、`created_at`、`last_accessed`、`status`
- `entity_index`：实体倒排索引，图谱扩散用
- `memories_fts`：FTS5 外部内容表（trigram，触发器同步）
- `meta`：进化参数与运行状态
- 首次运行自动写入 10 条"灵魂初始记忆"（`mem_001`~`mem_010`）

## 安装（作为 DSH bundle）

在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 添加本包，并在 `dsh.profile.bundles` 追加 `"dsh-xiaofei-memory"`（或直接用 `dsh plugin` / 插件市场安装）。包内 `cordis.patch.yml` 会插入插件行。

```yaml
# cordis.patch.yml（bundle 自带，无需手写）
- insert:
    - id: dsh-xiaofei-memory
      name: 'dsh-xiaofei-memory'
```

插件 `inject` 依赖 `["tools"]`；`agent/pre-step`、`session/event`、`tools/result` 经由事件载荷与 `ctx.get` 访问，`llm` 可选。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dbPath` | `$DSH_HOME/plugin-data/...` | SQLite 路径覆盖 |
| `extractionModel` | `deepseek-chat` | 独立抽取模型名（配合 `useLlmExtraction`） |
| `useLlmExtraction` | `false` | 是否启用 LLM 抽取（默认启发式，免依赖） |
| `dampFactor` | `0.85` | 纠错阻尼因子 |
| `timeDecayFactor` | `0.01` | 时间衰减因子 |
| `enableGraphRecall` | `true` | 图谱 1 跳扩散开关 |
| `sleepTimeHour` | `3` | 夜间睡眠小时（0-23） |
| `maxRecallTokens` | `1200` | 单次注入记忆 token 上限 |
| `roleId` | `global` | 默认角色命名空间 |
| `correctionTools` | `[]` | 触发纠错阻尼的工具名（默认空=不自动） |
| `recallLimit` | `8` | 主检索条数上限 |

## 引擎

- **Capture**：`turn/end` 异步抽取 `content`/`entities`/`layer`；落库查重——相似度 ≥0.92 合并（`strength+0.1`），≥0.75 冲突则归档旧、新覆盖。
- **Retrieval**：FTS5（trigram）+ LIKE 候选 → 大二元相似度打分 → `(0.35 + 0.65×相似度)×强度×exp(-0.01×天数)`；图谱 1 跳（`confidence≥0.8`，最多 2 条）；内省查询（"我是谁"）自动召回身份/陪伴灵魂记忆；token 预算按 `core > weekly > recent > 扩散` 优先级。
- **Feedback**：`tools/result` 命中 `correctionTools` 时对最近召回记忆 `strength×0.85`，15 分钟未再纠错则恢复。
- **Sleep**：同实体 recent 超 10 条 → 压缩为核心摘要（`origin_ids` 溯源），归档原记忆，VACUUM + FTS optimize。
- **Evolution**：夜间统计召回纠错比，高纠错则下调检索权重、上调衰减，写入 `meta`。

## 对外 API（`memory-core`）

`ctx.provide('memory-core', { retrieve, addFact, damp, stats })`：

- `retrieve(query, opts)` → `{ text, injectedIds, recalled }`
- `addFact({ content, roleId, layer, entities })` → `{ id, merged }`
- `damp(id)` → 阻尼单条记忆
- `stats()` → `{ active, evolution }`

另注册 `memory_core_retrieve` / `memory_core_add_fact` 工具。

## 验收

运行 `test-engine.mjs`（引擎逻辑 21 项）与 `test-load.mjs`（插件装载 20 项）验证。已覆盖：建表+10 初始记忆、角色隔离、内省检索召回"赛博战友/陪伴"、单次检索注入 <50ms、夜间蒸馏归档不膨胀、进化参数持久化。

```bash
node test-engine.mjs && node test-load.mjs
```
