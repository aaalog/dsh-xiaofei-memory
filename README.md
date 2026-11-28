# dsh-xiaofei-memory

一个无头、异步、具备新陈代谢能力的长期记忆引擎，是 DeepSeek Harness (DSH) 的函数式插件。
它不干涉对话逻辑与角色路由，只作为底层的「数字海马体」，提供带权重的记忆读写服务。

> 技术栈：ESM JavaScript + `node:sqlite`（需 Node ≥ 22.13.0，**零第三方运行时依赖**）。
> 当前版本 `0.3.0`，面向 DSH `0.2.2-rc.3`。

## 三层可见性

记忆对模型有三种呈现方式，代价从高到低：

| 层 | 位置 | 内容 | 每轮成本 |
|---|---|---|---|
| **常驻（身份）** | `systemPrompt` 段 `memory:core` | **只有一条**：由十条种子记忆蒸馏出的身份摘要 | ~200 tokens |
| **索引（目录）** | 紧随其后 | 未进常驻、但值得列出标题的记忆，一行一条 | 200 tokens 预算 |
| **检索（按需）** | `agent/pre-step` 注入 | 与当前问题相关的记忆正文 | 1200 tokens 预算 |

**设计取舍**：常驻块不放"最近发生的事"，只放"我是谁"。聊出来的碎片即便被反复合并、strength
再高，也进不了常驻块——它们靠索引和检索被召回。这是刻意为之，不是遗漏。

## 核心架构

| 轨 | 事件 | 职责 |
|---|---|---|
| **主轨（读）** | `agent/pre-step` (waterfall) | 提取意图 → 候选召回 → 打分重排 → 注入 `<memory-recall>` |
| **旁轨（写）** | `session/event` `turn/end` | 旁路异步抽取 → 融合去重 → 落库（`queueMicrotask`，不阻塞主对话） |
| **后台（代谢）** | 每日 `sleepTimeHour` | 摘要提纯 → 归档 → VACUUM + FTS optimize → 清理过期归档 |

## 数据存储

默认路径 `$DSH_HOME/plugin-data/dsh-xiaofei-memory/memory.sqlite`，WAL 模式，`busy_timeout=5000`。

`memories` 主表：

| 列 | 说明 |
|---|---|
| `role_id` | 命名空间（角色隔离） |
| `layer` | `core` / `weekly` / `recent` |
| `content` | 正文，写入时**上限 400 字**并做凭据脱敏 |
| `entities` / `origin_ids` | 实体；蒸馏溯源 |
| `strength` / `created_at` / `last_accessed` | 权重与时间 |
| `status` | `active` / `archived` |
| `pinned` | 是否进入常驻块（**唯一入口**：种子摘要 + 显式 `core` 写入） |
| `superseded_by` / `archived_at` | 退休溯源：被谁取代、何时退休 |

`entity_index`：实体倒排，`confidence` 为 **1.0（正文里确实出现）/ 0.6（抽取推断）**，
图谱扩散的 `>= 0.8` 阈值因此真正生效。

## 关键行为

### 写入（capture）

- **永不产生 `core`**：`记住/必须` 这类强信号最多进 `weekly`；捕获强度 `0.8`（低于常驻门槛）。
- **自我过滤**：不捕获自身注入的 `<memory-recall>`、系统提醒、运行时附言（`Elapsed since…`）、
  后台任务/子代理完成通知。
- **凭据脱敏**：`密码是123`、`password is x`、`验证码 8899`、`Authorization: Bearer …`
  在正文与实体列都替换为 `***`；`密码学`、`验证码五分钟内有效` 这类正常表述不受影响。
- **去重**：先做全角色精确同文匹配（不看时间窗口），再做相似度扫描（最近 50 条）。
  - `≥0.92` 且关键 token 相同 → 合并（`strength +0.1`，`pinned` 只升不降，等长取新文本）
  - `≥0.75` → **退休旧的**（记 `superseded_by` / `archived_at`，7 天内可恢复）
  - **关键 token 不同（文件名/URL/数字）→ 视为不同事实，两条并存**，只阻止合并
- 关键 token 差异**绝不**据此退休：`订单 1234` 与 `订单 5678` 是两条事实，不是新旧版本。

### 读（retrieval）

1. 提取**意图**：多行取最后一行；单行按 `。！？；` 取最后一句；长单行取以最后一个问号结尾的窗口；
   剥掉「请问/帮我/麻烦」这类礼貌前缀。空格不当分句边界。
2. 候选：FTS5（trigram，按 3 字窗口构造）+ LIKE 子串（覆盖 2 字中文）。
3. 打分：`(1-w + w×意图覆盖率) × strength^0.5 × exp(-decay×天数)`，
   地板 `recallMinSim=0.3`；无词面重合直接返回空（不再回退"最近 200 条"）。
4. 图谱 1 跳扩散（仅正文命中实体）。
5. token 预算按 `core > weekly > recent > 扩散` 优先级填充。

### 夜间代谢（sleep）

- **跨进程租约**：`meta.sleepLease`，定时与手动通道都抢，`finally` 释放；一次只跑一遍。
- **蒸馏**：同实体分组（按 `role_id` 隔离），组内超过 `clamp(ceil(size×0.15), 3, 10)` 才触发；
  **摘要把最多的 8 条喂给 LLM，归档的正是这 8 条**，其余留到下一晚。
- **归档保留**：`archiveRetentionDays`（默认 7）内可恢复，过期才物理删除；种子会被复活，
  身份摘要显式豁免。
- **执行记录**：写入 `meta.sleepLog`（最近 30 次），含扫描量、阈值、蒸馏分组、归档计数、
  是否有总结器。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dbPath` | `$DSH_HOME/plugin-data/...` | SQLite 路径覆盖 |
| `roleId` | `global` | 默认命名空间（会话未指定角色时） |
| `roles` | 3 个内置 | `[{id,name,description,enabled}]`；`enabled:false` 会**真正停用**该命名空间 |
| `useLlmExtraction` | `false` | 启用 LLM **捕获抽取**（每轮一次模型调用）；同时隐含开启蒸馏总结器 |
| `enableSleepSummarizer` | `false` | **只**开启夜间蒸馏总结器，不影响每轮捕获 |
| `extractionProvider` | 空 | 显式指定 provider 路由；空 = 自动发现声明该模型的第一个 provider |
| `extractionModel` | `deepseek-chat` | 抽取/蒸馏共用模型名 |
| `enableCoreMemory` | `true` | 常驻身份块 |
| `coreMemoryMaxTokens` | `650` | 常驻块 token 预算 |
| `coreMemoryMaxItemChars` | `300` | 单条渲染上限 |
| `coreMemoryMinStrength` | `1.0` | 进入块的强度门槛 |
| `coreMemoryPinnedOnly` | `true` | **只放 `pinned` 行**；设 `false` 退回旧的"强度排序" |
| `enableMemoryIndex` | `true` | 索引层开关 |
| `memoryIndexMaxTokens` | `200` | 索引层 token 预算 |
| `memoryIndexLimit` | `40` | 索引候选上限 |
| `maxRecallTokens` | `1200` | 单次注入预算 |
| `recallLimit` | `8` | 主检索条数 |
| `recallMinSim` | `0.3` | 相关性地板 |
| `enableGraphRecall` | `true` | 图谱 1 跳扩散 |
| `sleepTimeHour` | `3` | 夜间代谢小时 |
| `archiveRetentionDays` | `7` | 退休记忆保留天数（非法值回落 7，不会变成立即删除） |
| `dampFactor` | `0.85` | 纠错阻尼 |
| `timeDecayFactor` | `0.01` | 时间衰减 |
| `correctionTools` | `[]` | 触发纠错的工具名（默认空 → `runEvolution` 不会触发，见「已知限制」） |

## 工具

| 工具 | 作用 |
|---|---|
| `memory_core_retrieve` | 主动检索，返回可注入的 `<memory-recall>` 文本 |
| `memory_core_add_fact` | 写入事实；`layer:"core"` 时自动 `pinned`，进入常驻块 |
| `memory_core_read` | 按 id 读全文；命中已归档行时提示「被谁取代」并给出恢复方式 |
| `memory_core_restore` | 恢复保留期内被归档的记忆 |

写工具会校验调用方命名空间：只能写自己的角色或 `global`，停用角色拒写。

## 管理控制台与 View

- **Conversation View**（`conversation.view`，`id: dsh-xiaofei-memory`，order 40）：记忆海 canvas +
  常驻块预览 + 统计 + 内嵌控制台。声明 `data-conversation-composer-overlay`，占满整列、不显示对话输入框。
- **Settings 面板**（`settings.section`）：角色、记忆图谱、夜间睡眠（含执行记录）、底层系统。
- 列表统一为**行式 + 分页**（每页 ≤12 条，按窗口高度自适应）；一套间距/字号刻度。
- 数据经 `POST /dshxf/bridge` 获取。鉴权顺序：**先看 `x-dshxf-token`**（token 由
  `webserver/index-inject` 注入页面，脚本也可直接用），再退到 DSH 的会话 cookie。

## 构建与安装

```bash
node build.mjs     # 产出 dist/index.js（host）+ dist/client/index.js（browser），并写入 BUILD_STAMP
npm test           # 11 个套件，364 项断言
```

作为 bundle 安装（profile 的 `package.json` 需**钉完整 40 位 commit**，否则 DSH 不认为它是可更新的
Git 包）：

```json
"dsh-xiaofei-memory": "github:aaalog/dsh-xiaofei-memory#<40-hex-commit>"
```

改完 host 代码必须**重启 DSH**；只改 client 时刷新页面即可。两者不一致时 View 会显示构建戳漂移告警。

## 已知限制

- **无 embedding**：检索是词面（FTS5 trigram + LIKE + 二元组）而非语义。
- **2 字中文 FTS 失效**：trigram 需 3 字，2 字查询靠 LIKE 全表扫兜底。
- **候选上限 4000**：10k 规模、上万条同词命中时会退化为"只评分前 4000 条"，答案可能在窗外；
  273 条实测最慢 22ms，10k 全命中约 145ms。
- **`runEvolution` 实际未生效**：`correctionTools` 默认空，`recallStats.corrections` 恒 0，
  自适应调参从未触发（`recallStats.count` 正常递增）。
- **捕获兜底**：会话没有 `roleId` 时写入 `global`，即共享命名空间。
- **未发布到 npm / 插件市场**：升级靠改 SHA 重装重启，没有"点击更新"。
- 超过 400 字的历史行不会被自动重写，裁剪是显式的手工步骤。
