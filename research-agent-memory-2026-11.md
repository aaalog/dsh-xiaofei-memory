# AI Agent / LLM 长期记忆系统 赛道调研

> 调研时间：2026-11。数据分级：**【实测】** = 论文/官方基准页给出可复现数字；**【厂商】** = 厂商自述、无第三方复现；**【推断】** = 由公开实现/文档反推。
> GitHub star 数为 2026-11-13 通过 GitHub API 实时抓取。

---

## 0. 结论速览（先看这 8 条）

1. **赛道已从「向量检索」分裂为三条路线**：抽取式事实库（Mem0）、时序知识图谱（Zep/Graphiti、Cognee、Supermemory）、以及「让 LLM 自己管上下文」的 OS/文件系统路线（Letta MemFS）。三者不是同一层的竞品。
2. **LOCOMO 已被打穿，DMR 已彻底饱和**。Zep 自己的论文里，**纯全上下文基线（gpt-4o-mini）在 DMR 上拿到 98.0%，反超 MemGPT 的 93.4%**——DMR 作为基准已失去区分度（[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)）。
3. **LongMemEval 才是当前主战场**，且区分度真实：Zep 63.8%(4o-mini) / 71.2%(4o) vs 全上下文 55.4% / 60.2%，同时上下文从 115k 压到 1.6k tokens、延迟 31.3s → 3.20s（[同文 Table 2](https://arxiv.org/html/2501.13956v1)）。
4. **benchmark 数字互相打架，且打架方式是「选择性引用」**。Mem0 论文测 Zep 得 65.99 J，Zep 官网宣称 LoCoMo 94.7%；两者指标定义不同（LLM-as-Judge 分 vs 准确率）却被并列传播。这是本赛道最脏的地方。
5. **写入路径的真实成本被系统性低估**。Mem0 论文实测：向 Zep 写入后立刻检索**经常失败**，延迟数小时后再查才正常，判断其图构建含多次异步 LLM 调用（[arXiv:2504.19413](https://arxiv.org/html/2504.19413v1)）。图谱类方案的写放大是结构性的。
6. **「遗忘」几乎全行业缺失**。唯一称得上机制化的只有：Mem0 的 expiration（只隐藏不删除）、Cognee 的 `forget()`（显式删除，非自动）、Generative Agents 的 0.995 指数衰减 + 反思压缩。**没有一家做出可信的自动代谢/衰减闭环。**
7. **HippoRAG 的海马体类比被大量借用，但极少被真正实现**。HippoRAG 的核心是 **Personalized PageRank（PPR）在 KG 上做全局扩散**；市面上自称「海马体」的方案多数只做到 **1-hop 图扩展 + 关键词加权**，与 PPR 的全局概率传播不是一回事（详见 §6）。
8. **没有一家与 Cordis / Koishi 这类插件式 harness 深度集成**。主流方案都是 HTTP/SDK 外挂服务，唯一原生贴合插件运行时的是本地库形态（SQLite + FTS5），代价是放弃语义向量。

---

## 1. 总览对比表

| 系统 | 架构核心 | 写入路径（触发 / 是否 LLM / 是否阻塞） | 读取路径 | 遗忘·衰减·压缩 | 部署与强依赖 | 公开延迟/成本 | 主要缺点 |
|---|---|---|---|---|---|---|---|
| **Mem0 / Mem0ᵍ** | 向量事实库；ᵍ 版加实体-关系图 | 每对话**消息对**触发抽取（LLM，带会话摘要做上下文）→ 对相似记忆做 `ADD/UPDATE/DELETE/NOOP` 工具调用决策（LLM） | 向量检索 top-k（默认 k=10），无重排；直接拼进 prompt | 有 `expiration_date`，**只隐藏不删除**；无自动衰减 | SaaS / 自托管库；**需外部向量库**（默认 Qdrant），图谱需 Neo4j/Memgraph/Neptune/Kuzu | **【实测】** 搜索 p50 **0.148s** / p95 0.200s；端到端 p50 0.708s / p95 **1.440s**；上下文 **1,764 tokens**；J=**66.88** | 写入两次 LLM 调用，成本随对话线性增长；抽取质量不稳；事实粒度碎 |
| **Mem0ᵍ（图）** | 向量 + 图双存 | 同上 + 图构建（LLM 抽实体/关系） | 向量 + 图遍历混合 | 同上 | 同上 + 图数据库 | **【实测】** p50 1.091s / p95 **2.590s**；**3,616 tokens**；J=**68.44** | 延迟翻倍、token 翻倍，仅换 **+1.56 J**，性价比差 |
| **Zep + Graphiti** | **时序知识图谱**（bi-temporal：`valid_at`/`invalid_at`），episode 作溯源 | 增量式，episode 入库即构图；**多次异步 LLM 调用**（实体抽取→消解→事实抽取→消解→时序抽取） | 混合检索：语义向量 + BM25 + 图遍历；返回节点/边子图 | **靠事实失效（invalidation）而非衰减**：新事实使旧边 `invalid_at`，历史保留 | SaaS（Zep Cloud，自研 Konig 图库）/ 自托管 Graphiti 库；**需图数据库**（Neo4j 5.26 / FalkorDB / Neptune+OpenSearch；Kuzu 已废弃） | **【实测】** LongMemEval 延迟 **3.20s**(4o-mini) / **2.58s**(4o)；上下文 **1.6k tokens**；DMR 98.2% | **写入延迟数小时**（Mem0 实测）；图构建成本高；Mem0 测得 J 仅 65.99；小模型上 knowledge-update 反降 3.36% |
| **Letta（原 MemGPT）** | **OS 式分层 + 现在转为 git 文件系统**：main context（system+working+FIFO）/ 外部 archival+recall；2026 版改为 **MemFS**（git 仓库，按路径寻址的 Markdown+YAML） | **LLM 自主决定**何时读写（function call，`request_heartbeat` 链式）；70% 上下文触发 memory pressure 警告，100% 触发 flush+递归摘要 | LLM 主动 `archival_search`/读文件；**无自动检索注入** | **有**：FIFO 淘汰 + 递归摘要压缩 + `dreaming` 后台反思重组 | 自托管 / Cloud；MemFS 云端由 Letta 托管 git；**不强制外部向量库** | 无官方延迟数字；成本 = 每次记忆操作多一轮 LLM 推理 | 依赖模型能力，弱模型不会用；每轮多轮 function call 开销大；MemFS 偏 coding agent，非通用对话 |
| **LangMem（LangChain）** | LangGraph Store 之上加记忆语义层：semantic（collection/profile）/ episodic / procedural | 双模：**hot path**（对话中同步抽取，阻塞）或 **background**（异步，subconscious） | 语义检索（需向量库）+ namespace 过滤；profile 是「受管文档」被 LLM 反复改写 | 无自动衰减；靠 namespace 覆盖写 | 库；**强依赖 LangGraph Store + 向量库** | **【实测·被竞品测】** LOCOMO J：单跳 62.23 / 多跳 47.92 / 开放域 71.12 / **时序仅 23.43** | 生态绑定 LangChain；时序推理是明显短板；GitHub 仅 1,765 stars，维护弱 |
| **Cognee** | **三库并存**：关系库（provenance）+ 向量库 + 图库 | ECL 管道（`cognify` / `memify`），Task/DataPoint 图式流水线；批量、LLM 参与 | 图+向量混合检索，可自定义检索流程 | **`forget()` 显式删除**（单条/数据集/全清），非自动衰减 | 库 / 自托管；默认轻量本地（SQLite/LanceDB/Kuzu），可换生产后端 | **【实测】** BEAM-100K **0.79**、LoCoMo **约 91%**；官方公开评测代码与 judge 结果 | 管道重、上手陡；图构建贵；偏「文档知识库」而非对话记忆 |
| **Memobase** | **结构化用户画像**（topic/subtopic 槽位，如 `interests/movies`） | **缓冲 + 批量**处理，摊销 LLM 成本；异步 | 直接返回**预编译画像**，无检索、无重排 | 无衰减；靠槽位覆盖 | SaaS / 自托管；需 Postgres | **【厂商】** 比 mem0「约 5x 更省、5x 更快」（[docs](https://docs.memobase.io/cost)） | 表达力被槽位锁死；不适合事件/时序；repo 2026-01 后停更迹象 |
| **Supermemory** | 自研**学习模型** + 时序向量-图引擎（Vector + FTS + 图同体） | 摄取管道：文件/对话 → 学习模型决定「记什么、什么重要、何时忘、建什么关系」 | 语义 + 全文 + 图混合 | **有遗忘**：`DELETE`（精确 ID）与 `DELETE .../semantic`（按语义）；namespace 隔离 | SaaS 为主（有开源自托管）；内部自研引擎 | **【厂商】** 宣称「极快、可扩展」；无独立复现数字 | 黑盒（学习模型不公开）；v3/v4 于 2026-12-31 关停，API 迁移频繁 |
| **Memori** | 「agent-native」记忆层，SQL 原生（记忆即表） | 从 agent **行为**（工具调用/执行轨迹）抽取，非仅对话 | SQL 查询 + 可选向量 | 未查到明确机制 | 库 / Cloud；**LLM、datastore、framework 无关** | 无公开延迟数字 | 定位偏「可观测/审计」；语义能力弱于专做检索的方案 |
| **mnemostack** | 混合检索栈：semantic + BM25 + temporal + graph（Qdrant + Memgraph） | SDK/事件摄取，后台服务化 | **RRF 融合 + 8 阶段排序**；支持 `as_of` 时点查询、来源有效性追踪 | 未查到自动衰减；有来源失效追踪 | 自托管（库/服务）；**需 Qdrant + Memgraph** | 无公开数字；工程细节最透明 | 项目小、生态薄；运维两个数据库的门槛 |
| **mind-mem** | **无向量**：BM25F 词法 + 共检索图（类 PageRank 传播）+ 治理写 | 治理写（governed-write），提案制；哈希锚定审计 | 4 信号重排（否定感知 / 日期高斯衰减 / 20 类分类匹配 / 新近度）+ 2-hop 交叉引用加权（1-hop 0.3x、2-hop 0.1x） | **有**：重要度指数衰减（重要性钳制在 [0.8,1.5] 作重排增益） | 本地库 + MCP（107 个工具） | 无公开延迟数字；宣称共检索图带来 **+2.0pp** 准确率 | 无语义泛化（同义改写即失效）；工具面过于臃肿 |

> 说明：Mem0 与 Mem0ᵍ 的延迟/token/J 分数均取自 [arXiv:2504.19413 Table 2](https://arxiv.org/html/2504.19413v1)；Zep 行在同一张表内被 Mem0 实测为 3,911 tokens / p95 2.926s / J 65.99，**与 Zep 自报数字冲突**，见 §5。

---

## 2. 分系统详解

### 2.1 Mem0 / Mem0ᵍ（mem0.ai）

- **架构核心**：两层。基础版是**扁平事实库**（自然语言事实 + 向量索引）；`Mem0ᵍ` 在此基础上加**实体-关系图**，用于捕获跨会话的关系结构。官方定位是「memory layer」，不是 agent runtime。
- **写入路径**（两阶段，见 [论文 §2](https://arxiv.org/html/2504.19413v1)）：
  1. **抽取阶段**：以**消息对** `(m_{t-1}, m_t)` 为单位触发，输入 = 会话摘要 `S`（覆盖全部历史语义）+ 最近消息 + 新消息对 → LLM 产出候选事实。
  2. **更新阶段**：用向量检索出语义相近的已有记忆，连同候选事实一起喂给 LLM，通过 **function call** 让模型在 `ADD / UPDATE / DELETE / NOOP` 中四选一。论文明确说「不另设分类器，直接复用 LLM 推理」。
  - **是否阻塞**：抽取与更新都是同步 LLM 调用；官方 SDK 在 `add()` 返回后才算写完。工程上必须自己套异步队列，否则阻塞对话。
- **读取路径**：向量检索 top-k（论文默认 k=10），**无重排阶段**，直接拼接注入。`Mem0ᵍ` 额外做图遍历。
- **遗忘**：只有 `expiration_date`（`YYYY-MM-DD`，UTC 判定）。**关键限制：只隐藏不删除**——`search()`/`get_all()` 跳过，按 ID 仍可取回，清空日期即恢复（[docs](https://docs.mem0.ai/platform/features/memory-expiration.md)）。没有自动衰减、没有重要性衰减、没有压缩。
- **部署与依赖**：SaaS（app.mem0.ai）+ 开源自托管。**必须外部向量库**（Qdrant 为默认，可换 pgvector/Chroma/Milvus 等）；图模式再加 Neo4j / Memgraph / Neptune / Kuzu。provider SDK 是可选 peer dependency，按需装。
- **延迟与成本**【实测】：搜索 p50 **0.148s**、p95 0.200s；端到端 p50 0.708s、p95 **1.440s**；平均上下文 **1,764 tokens**；LOCOMO J=**66.88±0.15**。相对全上下文：**p95 延迟低 91%、token 省 90%+**（[摘要](https://arxiv.org/abs/2504.19413)）。图模式：p95 2.590s、3,616 tokens、J=68.44。
- **明确缺点**：
  - **写放大**：每轮对话至少 2 次 LLM 调用，长会话成本线性上升，且抽取结果不稳定（同一事实可能反复 ADD/DELETE）。
  - **粒度碎**：事实被切成独立短句，丢失叙事连续性——这正是 Zep 主打的攻击点。
  - **无重排**：纯向量 top-k，对时序类查询天生弱（见其 LOCOMO 时序分项）。
  - **图谱性价比低**【实测】：多花 2x 延迟 + 2x token，只换 +1.56 J。
  - 生态极大（68,901 stars）但 issue 里长期抱怨「记忆重复/膨胀」。
- **与 agent runtime 集成**：无深度集成。提供 REST + 各语言 SDK + 若干框架 adapter，本质是**外挂 HTTP 服务**。对 Cordis/Koishi 这类插件式 harness，只能当远程依赖，拿不到 pre-step 钩子级的控制权。

### 2.2 Zep + Graphiti（getzep.com）

- **架构核心**：**时序知识图谱**。Graphiti 是引擎，Zep 是托管服务。图是 **bi-temporal** 的：每条事实带 `valid_at` / `invalid_at`，新事实不覆盖旧事实，而是**让旧边失效**，历史完整保留（[Graphiti README](https://github.com/getzep/graphiti)）。原始输入以 **episode** 形式留存作 provenance，每个实体/关系都能回溯到 episode。
- **写入路径**：**增量式**，「新数据立即整合，无需批量重算」。但内部是**串行多次 LLM 调用**：实体抽取 → 实体消解 → 事实抽取 → 事实消解 → 时序抽取（论文附录 6.1 列了 5 组 prompt）。这也是其写入慢的根因。
- **读取路径**：**混合检索**——语义 embedding + BM25 关键词 + 图遍历，三者融合。返回的是节点/边子图，再由 LLM 组装。
- **遗忘**：**不靠衰减，靠失效**。矛盾事实自动 invalidation 并保留时序历史（README 对比表明确写「Automatic fact invalidation with temporal history preserved」）。这比「衰减」更接近真实记忆，但**存储只增不减**。
- **部署与依赖**：Zep Cloud（自研图库 **Konig**，「无需第三方图数据库」）/ 自托管 Graphiti。自托管**必须有图数据库**：Neo4j 5.26、FalkorDB 1.1.2、Amazon Neptune（+ OpenSearch Serverless 做全文检索）；Kuzu 0.11.2 **已废弃**。默认走 OpenAI 做 LLM + embedding，且**需要支持 Structured Output 的模型**。
- **延迟与成本**【实测】：LongMemEval 上 3.20s（4o-mini）/ **2.58s**（4o），对比全上下文 31.3s / 28.9s；平均上下文 **1.6k tokens**（vs 115k）。准确率 63.8% / 71.2%（+15.2% / +18.5%）。官网另称 LoCoMo **94.7%**、检索延迟 **155ms**（【厂商】，[research 页](https://www.getzep.com/research/memory-benchmarks/)）。
- **明确缺点**：
  - **写入延迟可达数小时**。Mem0 论文实测：「加入记忆后立即检索经常答错；延迟数小时重跑同样查询结果明显更好」，据此判断其图构建含大量异步 LLM 调用，**不适合实时场景**（[arXiv:2504.19413](https://arxiv.org/html/2504.19413v1)）。
  - **token 膨胀**：Mem0 测得 Zep 单次检索 3,911 tokens，而原始全对话平均仅约 26k——即「记忆层比原文还贵」的批评；并指其「在多个节点间复制相同知识碎片」。
  - **弱模型反而更差**：Zep 自己承认 gpt-4o-mini 在 `knowledge-update` 上 **76.9% → 74.4%（-3.36%）**、`single-session-assistant` **81.8% → 75.0%（-9.06%）**，需要「更多开发才能让弱模型理解其时序数据」。
  - 自托管要维护图库 + 全文检索两套存储，运维重。
- **与 agent runtime 集成**：无原生集成。Graphiti 是 Python 库 + REST，Zep 是 SaaS。

### 2.3 Letta（原 MemGPT，letta.com）

**这是全场演进最大的一家，必须分两代看。**

- **第一代（MemGPT，[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）：OS 式虚拟上下文管理。**
  - **架构**：main context（= 提示词 token：system instructions + working context + FIFO 队列）vs external context（= archival storage 任意长文本库 + recall storage 消息史）。类比 RAM / 磁盘。
  - **写入**：**LLM 自主决定**。通过 function call 在两层间搬运数据；`request_heartbeat=true` 允许链式多步检索。上下文用到 **70% 触发 memory pressure 警告**，**100% 触发 flush**：淘汰约 50% 消息 + 用递归摘要压缩。
  - **读取**：LLM 主动发起 `archival_search`，**没有自动检索注入**——这是与 Mem0/Zep 的根本差异：检索是 agent 的显式动作，不是 harness 的隐式步骤。
  - **遗忘/压缩**：**有，且是全行业最完整的**：FIFO 淘汰 + 递归摘要 + 分页式检索防溢出。
  - **实测**：DMR **93.4%**（gpt-4-turbo），对比递归摘要基线 35.3%。
- **第二代（2026，Letta Code / MemFS）**：已经把 memory blocks 换成 **MemFS——git 版本化的记忆文件系统**。
  - 记忆是 agent 自己的 git 仓库，**按路径寻址**：label `persona` → `persona.md`，带 YAML frontmatter，`MEMORY.md` 作索引。
  - agent 用**普通文件工具**读写记忆，本地编辑、commit+push 后「在所有机器上生效」。
  - 提供 `/init`（初始化/刷新）、`/doctor`（审计错位、重复、system-prompt token 占用）、`/remember`（显式教学）、`/memory`（查看）。
  - **`dreaming`**：后台反思式重组记忆；配合 sleep-time subagents。
  - 设计纲领是 **Context Constitution**：规定 agent 把什么放进上下文、什么顺序、什么粒度、放多久（[docs](https://docs.letta.com/llms.txt)）。
- **部署**：自托管 / Cloud；MemFS 云端由 Letta 托管 git，自托管可指向自己的 git remote。
- **缺点**：无公开延迟基准；**每次记忆操作多一轮 LLM 推理**，成本高；强依赖模型能力（弱模型不会正确调用记忆工具）；MemFS 明显偏向 coding agent 场景，通用对话记忆的表达力不如结构化方案。
- **与 agent runtime 集成**：**理念上最接近**（agent 自管上下文、有 pre-step 级钩子语义、有 harness），但它是完整 runtime 而非插件，与 Cordis 是**替代关系而非嵌入关系**。

### 2.4 LangMem / LangGraph memory

- **架构**：不是独立存储，是 **LangGraph Store 之上的记忆语义层**。三类记忆：semantic（`collection` 事实集 / `profile` 受管文档）、episodic（过往经历）、procedural（system prompt 优化）。用 **namespace** 做多租户/多 agent 隔离。
- **写入**：两条路径——
  - **Hot path（conscious formation）**：对话中同步抽取，**阻塞**，延迟可感知。
  - **Background（subconscious formation）**：异步后处理，官方推荐「defer background memory processing」。
  - Profile 的机制很特别：把用户画像当成**一份被 LLM 反复重写的文档**，而非一堆事实。
- **读取**：语义检索（**需外部向量库**）+ namespace 过滤；profile 直接注入。
- **遗忘**：无自动衰减，靠 namespace 覆盖写。
- **实测短板**【第三方实测】：Mem0 在 LOCOMO 上测 LangMem，J 分为 单跳 62.23 / 多跳 47.92 / 开放域 71.12 / **时序仅 23.43**。时序推理是硬伤，被 Mem0 点名「落后 8% 相对分」。
- **生态**：GitHub 仅 **1,765 stars**（对比 Mem0 68,901），是「大厂体系内的小项目」，更新依赖 LangChain 主线。
- **与 agent runtime 集成**：绑定 LangGraph。非 LangChain 栈接入成本高。

### 2.5 Cognee（知识图谱 + 向量）

- **架构**：**三库并存**，这是它最清晰的差异点（[architecture](https://docs.cognee.ai/core-concepts/architecture)）：
  - **关系库**：文档、chunk、**provenance**（数据来源与链接关系）
  - **向量库**：语义相似
  - **图库**：实体与关系
- **写入**：ECL 管道（Extract–Cognify–Load）。`cognify` 建图，`memify` 做记忆增强/自改进。基于 **Task / DataPoint** 的统一流水线结构，三条管道（session learning / self-improvement / ingestion）共用。
- **读取**：图 + 向量混合检索，检索流程可编程替换。
- **遗忘**：**`forget()` 是 v1.0 的统一删除命令**，可删单条 / 整个 dataset / 用户可删的一切；`memory_only=True` 只清图与向量、保留原始文件以便重跑 `cognify`；`clean_history=True` 连带删检索历史（[docs](https://docs.cognee.ai/core-concepts/main-operations/forget.md)）。**是显式删除，不是自动衰减。**
- **实测**【罕见地可复现】：**BEAM-100K = 0.79**（4 次运行，std 0.005）、**LoCoMo ≈ 91%**；官方把答案、judge 判定、配置全放在 repo 的 `eval_framework` 里，可逐条核验（[benchmarks](https://docs.cognee.ai/core-concepts/evaluation-and-efficiency/accuracy-benchmarks)）。这是本赛道**证据链最完整**的一家。
- **部署**：库 / 自托管。默认轻量本地（SQLite + LanceDB + Kuzu），可换生产后端。
- **缺点**：管道重、概念多（cognify/memify/ECL/DataPoint），上手陡；图构建贵；定位偏「文档知识库」，对话记忆是附带能力。
- **集成**：Python 库 + API，无 harness 级集成。GitHub 33,288 stars，2026-11-13 仍在活跃提交。

### 2.6 新兴方案

| 方案 | 一句话定位 | 关键机制 | 状态 |
|---|---|---|---|
| **Memobase** | 结构化**用户画像**记忆 | 预定义 topic/subtopic 槽位（`interests/movies`）；写入走**缓冲区批量处理**摊销 LLM 成本；读取直接返回**预编译画像**（无检索、无重排，故快） | 2,955 stars，2026-01 后无提交；【厂商】称比 mem0 省 5x、快 5x |
| **Memori** | agent-native 记忆基础设施 | 从 agent **行为/执行轨迹**抽取（「memory from what agents do, not just what they say」）；LLM/datastore/framework 全无关；Python + TS SDK | 17,563 stars，活跃 |
| **Supermemory** | 学习模型 + 时序向量图引擎 | 自研**学习模型**决定「记什么/什么重要/何时忘/建什么关系」；Vector+FTS+图同体；遗忘支持精确 ID 与语义两种 `DELETE`，namespace 隔离 | 31,608 stars，TypeScript；v3/v4 于 **2026-12-31 关停**，API 迁移频繁 |
| **mnemostack** | 自托管混合检索栈 | semantic + BM25 + temporal + graph（Qdrant + Memgraph）→ **RRF 融合 + 8 阶段排序**；支持 `as_of` 时点查询、来源有效性追踪；SDK/CLI/HTTP/MCP 四接口 | PyPI 3.2.0，Apache-2.0，小项目但工程最透明 |
| **mind-mem** | 确定性可重放的治理型记忆 | **无向量**：BM25F 词法 + **共检索图（类 PageRank 传播）** + 2-hop 交叉引用加权（0.3x/0.1x）；4 信号重排（否定感知 / 日期高斯衰减 / 20 类分类 / 新近度）；哈希锚定审计链、Q16.16 定点；107 个 MCP 工具 | PyPI 5.0.3，小众；宣称共检索图 **+2.0pp** |

> **未查到公开资料**：没有找到名为 `mnemostack`、`mind-mem` 之外的更多「新兴方案」具备可核验的架构文档；本表只列确有 PyPI/GitHub 实体且文档可读的项目。

### 2.7 学术侧

| 工作 | 核心思想 | 关键机制 | 公开结果 |
|---|---|---|---|
| **MemGPT**（[2310.08560](https://arxiv.org/abs/2310.08560)） | LLM 即 OS，虚拟上下文管理 | main/external context 分层；function call 搬运；memory pressure 警告（70%）→ flush（100%）→ 递归摘要；分页式检索 | DMR **93.4%**（gpt-4-turbo），基线递归摘要 35.3% |
| **A-Mem**（[2502.12110](https://arxiv.org/abs/2502.12110)，NeurIPS'25） | **Zettelkasten** 式agentic memory | 每条新记忆生成结构化笔记（上下文描述 / 关键词 / 标签）→ 分析历史记忆建立链接 → **memory evolution**（新记忆反向改写旧笔记的上下文） | 被 Mem0 实测：LOCOMO J 单跳 39.79 / 多跳 18.85 / 开放域 54.05 / 时序 49.91 |
| **HippoRAG**（[2405.14831](https://arxiv.org/abs/2405.14831)，NeurIPS'24） | **海马体索引理论**：KG + Personalized PageRank | LLM 抽实体建 KG；查询实体作种子在图上跑 **PPR** 做全局扩散，模拟海马体索引→皮层检索 | 多跳 QA 最高 **+20%**；单步检索媲美 IRCoT 且**便宜 10–30x、快 6–13x** |
| **HippoRAG 2**（[2502.14802](https://arxiv.org/abs/2502.14802)，ICML 2025） | 修补「图方案在基础事实题上不如朴素 RAG」 | PPR + **更深的 passage 整合** + **更有效的在线 LLM 使用** | 联想记忆 **+7%** 超 SOTA embedding；同时不牺牲事实性与 sense-making |
| **Generative Agents**（[2304.03442](https://arxiv.org/abs/2304.03442)） | **memory stream** + reflection + planning | 检索打分 `score = α_rec·recency + α_imp·importance + α_rel·relevance`，**三者 α 全为 1**；recency 为**每沙盒游戏小时 0.995 的指数衰减**；importance 由 LLM 打 1–10 分；**反思阈值 = 重要度累计 150**（实际约每天 2–3 次） | 25 agents 沙盒，涌现社交行为；组件消融验证三因子各自有效 |

---

## 3. 基准：分数真相与陷阱

### 3.1 三个基准的定位

| 基准 | 规模 | 考什么 | 现状 |
|---|---|---|---|
| **LOCOMO**（[2402.17753](https://arxiv.org/abs/2402.17753)） | 平均 **300 turns / 9K tokens**，**最多 35 个 session**；QA + 事件摘要 + 多模态 | 超长期对话记忆 | **已被打穿**，头部集中在 66–95（但指标口径混乱，见下） |
| **LongMemEval**（[2410.10813](https://arxiv.org/abs/2410.10813)） | **500 题**，历史可自由扩展至 115k+ tokens | 5 项能力：信息抽取 / 多会话推理 / 时序推理 / 知识更新 / **拒答** | **当前主战场**，区分度真实 |
| **DMR**（MemGPT 提出） | MSC 数据集，≤5 sessions、每 session ≤12 消息 | 深度记忆检索（窄答案域） | **已饱和**，应停止使用 |

### 3.2 LOCOMO 分数对照（同一张表，Mem0 论文实测）

| 方法 | 单跳 J | 多跳 J | 开放域 J | 时序 J | 搜索 p50/p95 (s) | 端到端 p50/p95 (s) | 上下文 tokens |
|---|---|---|---|---|---|---|---|
| A-Mem | 39.79 | 18.85 | 54.05 | 49.91 | – | – | – |
| **LangMem** | 62.23 | 47.92 | 71.12 | **23.43** | – | – | – |
| **Zep** | 61.70 | 41.35 | 76.60 | 49.31 | 0.513 / 0.778 | 1.292 / 2.926 | 3,911 |
| OpenAI（记忆功能） | 63.79 | 42.92 | – | – | – / – | 0.466 / 0.889 | 4,437 |
| **Mem0** | – | – | – | – | **0.148 / 0.200** | **0.708 / 1.440** | **1,764** |
| **Mem0ᵍ** | – | – | – | – | 0.476 / 0.657 | 1.091 / 2.590 | 3,616 |

> 注：原表中 LoCoMo / ReadAgent / MemoryBank / MemGPT 四行只报 F1/B1、**未报 J 分**（其分项 F1 依次为 MemGPT 单跳 26.65 / 多跳 9.15 / 开放域 41.04 / 时序 25.52），故不列入 J 分对比。
> 上表 J 分为 LLM-as-a-Judge 总分/分项，来源 [arXiv:2504.19413 Table 2](https://arxiv.org/html/2504.19413v1)。**Mem0 的总体 J：Mem0 66.88±0.15、Mem0ᵍ 68.44±0.17、Zep 65.99±0.16、OpenAI 52.90±0.14。**

### 3.3 LongMemEval 分数（Zep 自报，【实测】）

| Memory | Model | Score | Latency | Latency IQR | Avg Context Tokens |
|---|---|---|---|---|---|
| Full-context | gpt-4o-mini | 55.4% | 31.3 s | 8.76 s | 115k |
| **Zep** | gpt-4o-mini | **63.8%** | **3.20 s** | 1.31 s | **1.6k** |
| Full-context | gpt-4o | 60.2% | 28.9 s | 6.01 s | 115k |
| **Zep** | gpt-4o | **71.2%** | **2.58 s** | 0.684 s | **1.6k** |

分项（gpt-4o-mini，全上下文 → Zep）：single-session-preference 30.0% → 53.3%（+77.7%）；**single-session-assistant 81.8% → 75.0%（-9.06%）**；temporal-reasoning 36.5% → 54.1%（+48.2%）；multi-session 40.6% → 47.4%（+16.7%）；**knowledge-update 76.9% → 74.4%（-3.36%）**。

### 3.4 DMR 的死亡证明

Zep 论文 §4.2 自述（[arXiv:2501.13956](https://arxiv.org/html/2501.13956v1)）：

- MemGPT 原报 **93.4%**（gpt-4-turbo），递归摘要基线 35.3%
- 但**全对话上下文基线用 gpt-4-turbo 达 94.4%，gpt-4o-mini 达 98.0%**——已反超 MemGPT 原报数字
- 会话摘要基线 78.6% / 88.0%
- Zep 自己拿到 94.8%（4-turbo）/ **98.2%**（4o-mini）
- **Zep 明确写：无法复现 MemGPT 的结果，因其「已发表工作的方法细节不足」**

→ 结论：**DMR 上 93%–98% 的差距在噪声内，且一个「不做任何记忆管理」的基线就能赢**。任何仍以 DMR 作为主要卖点的方案，其数字应被折价看待。

### 3.5 关于「94.7%」这类数字的口径陷阱

- Zep 官网 LoCoMo **94.7%**、检索 **155ms**（[research](https://www.getzep.com/research/memory-benchmarks/)）；而 Mem0 论文实测 Zep 的 LOCOMO **J = 65.99**。两者不是同一指标（准确率 vs LLM-judge 分），也非同一 prompt/judge 配置。
- Cognee 自报 LoCoMo **≈91%**，但公开了 judge 判定与配置，**可核验性最高**。
- **判断规则**：只接受「同一张表内、同 judge、同模型」的横向比较；跨厂商数字只能做量级参考。

---

## 4. 延迟与成本横向对照（只列有公开数字的）

| 系统 | 检索/搜索延迟 | 端到端延迟 | 上下文开销 | 写入成本特征 |
|---|---|---|---|---|
| Mem0 | p50 0.148s / p95 0.200s | p50 0.708s / p95 1.440s | 1,764 tok | 每消息对 2 次 LLM 调用 |
| Mem0ᵍ | p50 0.476s / p95 0.657s | p50 1.091s / p95 2.590s | 3,616 tok | +图构建（实体/关系抽取） |
| Zep（Mem0 实测口径） | p50 0.513s / p95 0.778s | p50 1.292s / p95 2.926s | 3,911 tok | **异步、可延迟数小时** |
| Zep（LongMemEval 口径） | – | 3.20s / 2.58s | 1.6k tok | 同上 |
| Zep（官网自述） | **155 ms** | – | – | – |
| Memobase | 【厂商】比 mem0 快 ~5x | – | 画像预编译 | 缓冲批量，摊销 |
| Letta | 无公开数字 | – | 受 context 上限约束 | 每次记忆操作多一轮推理 |
| Cognee / Supermemory / Memori / mnemostack / mind-mem | **未查到公开延迟数字** | – | – | – |

> 全上下文基线：单次约 **26k tokens**（Mem0 论文），LongMemEval 场景 **115k tokens** / 28.9–31.3s。这就是所有记忆层要打败的对照组。

---

## 5. 明显的「厂商宣称 vs 实测」冲突清单

| 议题 | 厂商宣称 | 反证 |
|---|---|---|
| Zep 的图记忆效率 | 「超越 SOTA，延迟降 90%」 | Mem0 实测其单次检索 3,911 tok，**比原始全对话（约 26k）只省 6.6x，但比 Mem0 贵 2.2x**；且「在多个节点复制相同知识碎片」 |
| Zep 的实时性 | 「实时知识图谱」 | Mem0 实测：写入后**立即检索常失败**，数小时后才正常 →「对实时应用不实用」 |
| Mem0 的 91% 延迟改善 | 相对**全上下文基线** | 是相对最笨的基线；相对 Zep/Mem0ᵍ 优势小得多（p95 1.440 vs 2.590/2.926） |
| Mem0ᵍ 的图记忆价值 | 「时序推理显著更强」 | 多花 2x 延迟 + 2x token，总体 J 仅 **+1.56**（66.88→68.44） |
| DMR 的区分度 | 「超越 MemGPT」 | 全上下文基线 **98.0%** 已高于 MemGPT 的 93.4%（Zep 自己论文数据） |
| LangMem 的通用性 | LangChain 官方记忆方案 | LOCOMO 时序 J 仅 **23.43**，为全场最低之一 |
| Memobase 的 5x | 「5x 更省、5x 更快」 | 无第三方复现；对比对象是其自选配置 |

---

## 6. 专题：HippoRAG 与「海马体记忆」

### 6.1 神经科学原意

**海马体索引理论（hippocampal indexing theory）**：皮层负责存储分布式表征（内容），海马体不存内容，只存**指向皮层表征的索引**； retrieval 时海马体用部分线索**模式补全（pattern completion）**，激活整条皮层痕迹。HippoRAG 据此把 KG 当海马体、把 LLM 当新皮层。

### 6.2 HippoRAG 的工程实现（关键：PPR 是全局的）

1. **建索引**：LLM 做 OpenIE，从语料抽实体与关系 → 构成 KG（= 海马体索引）。
2. **查询时**：识别 query 中的实体作为**种子节点**，在 KG 上跑 **Personalized PageRank**——从种子出发做**概率质量的全图传播**，得到每个节点的稳态访问概率。
3. **取回**：按 PPR 分数排序，取 top-k passage 喂给 LLM（= 模式补全）。

**PPR 的本质**：不是「查询实体周围一跳」，而是求解 `p = α·s + (1-α)·Mᵀp` 的**不动点**——信息沿全图多跳传播并按图结构加权收敛。这让它天然具备：
- **多跳联想**：A→B→C 的链路能被一次性激活（普通向量检索只能命中 A）
- **hub 抑制**：PageRank 的分母天然惩罚高连接度节点，避免「什么都相关的万能实体」霸榜
- **可解释**：得分可回溯到传播路径

**实测**（[2405.14831](https://arxiv.org/abs/2405.14831)）：多跳 QA 最高 **+20%**；单步检索媲美迭代式 IRCoT，但**便宜 10–30x、快 6–13x**。

### 6.3 HippoRAG 2 修的是什么

HippoRAG 1 的致命伤：**在基础事实题上反而不如朴素 RAG**（图结构引入噪声、实体链接错误）。HippoRAG 2（[2502.14802](https://arxiv.org/abs/2502.14802)）保留 PPR，加两件事：
- **更深的 passage 整合**（passage 节点与实体节点联合建模，而非只用实体图）
- **更有效的在线 LLM 使用**（查询时用 LLM 做实体/关系筛选，而非纯离线索引）

结果：联想记忆 **+7%** 超 SOTA embedding，且事实性与 sense-making 不退化。**ICML 2025。**

### 6.4 对照：本仓库插件（runtime-xiaofei-memory）的「数字海马体」

该插件在 [README.md](README.md) 第 3 行自称「底层的『数字海马体』」。实测其实现（[src/retrieval.js](src/retrieval.js)）：

| 维度 | HippoRAG | 本插件 | 差距性质 |
|---|---|---|---|
| 索引结构 | 实体-关系 KG，LLM 做 OpenIE | `entity_index` 实体倒排 + FTS5 trigram | **无关系边**，只有实体共现 |
| 图传播 | **PPR 全图不动点求解**（多跳、hub 抑制） | **1-hop `graphExpand`**，`confidence: 0.8`、`limit: 2` | **本质不同**：一跳扩展≠概率传播 |
| 语义表征 | 实体 embedding + passage 节点 | **无 embedding**（`util.js` 注释：「不用 embedding 模型也够做去重和冲突检测」） | 同义改写即漏检 |
| 重排 | PPR 分数排序 | 层级优先（core>weekly>recent>diffusion）+ 分数 | 是规则排序，非图权重 |
| 模式补全 | PPR 收敛即补全 | 无 | – |

**结论**：该插件是「**FTS5 词法检索 + 实体一跳扩展 + 层级/时间加权重排**」，工程质量不错（异步旁轨写入、夜间代谢、token 预算注入、SQLite 零依赖），但**与 HippoRAG 的 PPR 机制不是同一类东西**。称其为「数字海马体」是**类比修辞，不是技术同构**——若要名副其实，最小改动是：给 `entity_index` 加共现边权 → 实现阻尼 PPR（α≈0.85）替代 1-hop 扩展 → 用 PPR 稳态分替代层级硬排序。

**这也解释了一个行业现象**：mind-mem 的「共检索图 + 类 PageRank 传播」、Zep 的图遍历、Cognee 的图检索，都在不同程度上借用「图传播」这个词，但只有 HippoRAG 明确求解 PPR 不动点。**「海马体」在本赛道已基本退化为营销词。**

---

## 7. 与 agent runtime 的集成度（针对 Cordis / Koishi / 插件式 harness）

| 方案 | 集成形态 | 能否拿到 pre-step / 生命周期钩子 | 适配插件式 harness 的难度 |
|---|---|---|---|
| Mem0 / Zep / Supermemory / Memobase | REST / SDK，**外挂服务** | ❌ 只能手动在业务代码里调 | 中（需自建异步队列，避免阻塞） |
| Letta | **完整 runtime**（自带 harness） | ✅ 但它是 runtime 本身 | **高**（与 Cordis 是替代而非嵌入） |
| LangMem | LangGraph 生态内 | ⚠️ 仅 LangGraph 节点内 | 高（绑定框架） |
| Cognee / Memori / mnemostack / mind-mem | 库 / 本地服务 / MCP | ⚠️ 需自己接 | 低–中（MCP 形态最友好） |
| **本地 SQLite 方案**（如本仓库插件） | **原生插件**，`agent/pre-step` waterfall + `session/event` | ✅ 完全控制 | **最低** |

**判断**：插件式 harness 的真正需求不是「更强的检索」，而是 **① 不阻塞主对话的写旁轨 ② 能在 pre-step 注入的结构化上下文 ③ 零外部依赖的可部署性**。这三条恰恰是 SaaS 记忆层最弱的地方——它们全都要求网络往返 + 外部数据库。**这是本地优先方案的结构性机会窗口。**

---

## 8. 赛道共性技术趋势

1. **从「扁平事实」走向「时序图」**。Mem0→Mem0ᵍ、Zep 的 bi-temporal、Supermemory 的 fact-based temporal graph、Cognee 的三库，全都在补「关系」和「时间有效性」。纯向量 fact store 已被认为是上一代。
2. **写入路径从同步转向异步/批处理**。Memobase 的缓冲批处理、LangMem 的 background 模式、Letta 的 dreaming、Zep 的增量异步构图——**「不阻塞对话」已成共识**，代价是记忆新鲜度（Zep 的数小时延迟就是极端案例）。
3. **上下文预算成为一等公民**。竞争指标从「准确率」变成「**准确率 @ 固定 token 预算**」。Zep 的 1.6k vs 115k 是标杆式叙事；Mem0 的 1,764 tokens 同理。
4. **「让 LLM 自己管记忆」与「让系统管记忆」分道扬镳**。Letta 走前者（function call 自主读写、MemFS 文件系统），Mem0/Zep 走后者（自动抽取注入）。前者上限高但依赖模型能力，后者稳定但天花板低。
5. **记忆开始被当作「文件系统/状态」而非「数据库」**。Letta MemFS（git + Markdown + 路径寻址）是最激进的信号：记忆可 diff、可 commit、可 review、可多 agent 共享。
6. **基准从「回忆」转向「能力」**。LOCOMO/DMR 考「记不记得」，LongMemEval 考「抽取/多会话/时序/更新/拒答」五能力——**拒答（abstention）被单列，说明幻觉式记忆已被正视**。
7. **图 + 向量混合成为默认架构**，纯向量或纯图都难以自洽（HippoRAG 1 事实题退化、纯向量多跳失效，互为镜像）。

## 9. 普遍未被解决的问题（真空白区）

1. **没有可信的自动遗忘/代谢机制**。全行业只有：显式删除（Cognee/Memori）、过期隐藏（Mem0）、事实失效（Zep）、指数衰减（Generative Agents，2023 年的老论文）。**没有一家做到「重要性 × 新近度 × 检索频次」的自适应淘汰闭环**，更没有可验证的「遗忘收益」指标（省了多少 token、掉了多少准确率）。存储只增不减是普遍现实。
2. **写入成本无人正面披露**。除 Mem0 给了搜索/端到端延迟，**没有一家公布「每轮对话的写入 LLM 调用次数与美元成本」**。Zep 的数小时延迟是靠第三方（竞品）实测才曝光的。
3. **基准不可比，且已出现「指标套利」**。同一系统在自家论文、竞品论文、官网上的分数可以差 30 分。**缺少中立的第三方 leaderboard**（对比 MTEB 之于 embedding）。
4. **多跳/时序仍是硬伤**。LongMemEval 上即使最好的方案也只有 71.2%（4o）；LangMem 时序 J 仅 23.43。**「A 在 B 之后发生、B 使 C 失效」这类推理普遍失败**。
5. **记忆污染与自我强化无解**。LLM 抽取的事实进入记忆后会被反复检索、反复改写（A-Mem 的 memory evolution 尤甚），**错误会固化并放大**，且没有回滚机制（除 Letta 的 git 版本化）。
6. **多 agent / 多用户的记忆隔离与共享缺范式**。namespace（LangMem）、role_id（本地方案）、shared repository（Letta）各做各的，**没有权限模型、没有冲突解决**。
7. **评估「记忆是否被使用」的手段缺失**。LLM-as-a-Judge 只判答案对错，无法区分「答对了因为记得」与「答对了因为猜中」。**归因（attribution）是空白**。
8. **隐私与可删除性（被遗忘权）没有工程解**。向量库/图库里的记忆难以真正删除（图边、embedding 残影），Mem0 的「只隐藏不删除」在 GDPR 语境下是合规风险。
9. **小而美的方案缺乏维护**。Memobase 2026-01 后停更、LangMem 仅 1,765 stars、mnemostack/mind-mem 属个人项目——**赛道头部集中（Mem0 68.9k、Cognee 33.3k、Graphiti 32.8k、Supermemory 31.6k），长尾脆弱**。

---

## 10. 来源清单（按可信度排序）

**一手论文 / 官方基准页（可复现）**
- Mem0 论文：[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)（[全文 HTML](https://arxiv.org/html/2504.19413v1)）
- Zep 论文：[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)（[全文 HTML](https://arxiv.org/html/2501.13956v1)）
- MemGPT：[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
- A-Mem：[arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
- HippoRAG：[arXiv:2405.14831](https://arxiv.org/abs/2405.14831)
- HippoRAG 2：[arXiv:2502.14802](https://arxiv.org/abs/2502.14802)
- Generative Agents：[arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- LOCOMO：[arXiv:2402.17753](https://arxiv.org/abs/2402.17753)
- LongMemEval：[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)

**官方文档**
- Mem0：[how-it-works](https://docs.mem0.ai/core-concepts/how-it-works)、[memory-expiration](https://docs.mem0.ai/platform/features/memory-expiration.md)
- Graphiti：[README](https://github.com/getzep/graphiti)、[Zep benchmarks](https://www.getzep.com/research/memory-benchmarks/)
- Letta：[llms.txt](https://docs.letta.com/llms.txt)、[MemFS](https://docs.letta.com/concepts/memfs/index.md)、[memory & dreaming](https://docs.letta.com/configuration/memory/index.md)、[agent-sdk/memory](https://docs.letta.com/agent-sdk/memory/index.md)
- LangMem：[conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- Cognee：[architecture](https://docs.cognee.ai/core-concepts/architecture)、[forget](https://docs.cognee.ai/core-concepts/main-operations/forget.md)、[accuracy benchmarks](https://docs.cognee.ai/core-concepts/evaluation-and-efficiency/accuracy-benchmarks)
- Memobase：[introduction](https://docs.memobase.io/introduction)、[performance & cost](https://docs.memobase.io/cost)
- Supermemory：[how it works](https://supermemory.ai/docs/concepts/how-it-works.md)、[graph memory](https://supermemory.ai/docs/concepts/graph-memory.md)、[v5 forgetting](https://supermemory.ai/docs/migration/api-v5-memory-forgetting.md)
- mnemostack：[PyPI](https://pypi.org/project/mnemostack/)、[GitHub](https://github.com/udjin-labs/mnemostack)
- mind-mem：[PyPI](https://pypi.org/project/mind-mem/)
- Memori：[PyPI](https://pypi.org/project/memori/)、[GitHub](https://github.com/MemoriLabs/Memori)

**项目规模（2026-11-13 GitHub API 实测）**
| Repo | Stars | 主语言 | 最近推送 |
|---|---|---|---|
| mem0ai/mem0 | 68,901 | Python | 2026-11-06 |
| topoteretes/cognee | 33,288 | Python | 2026-11-13 |
| getzep/graphiti | 32,787 | Python | 2026-11-11 |
| supermemoryai/supermemory | 31,608 | TypeScript | 2026-11-11 |
| letta-ai/letta | 25,429 | – | 2026-10-18 |
| MemoriLabs/Memori | 17,563 | Python | 2026-10-03 |
| OSU-NLP-Group/HippoRAG | 4,119 | Python | 2026-10-06 |
| memodb-io/memobase | 2,955 | Python | 2026-01-11 |
| langchain-ai/langmem | 1,765 | Python | 2026-11-03 |
