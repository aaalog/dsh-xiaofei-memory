# dsh-xiaofei-memory 复审报告（第三轮）— 2026-11-23

审查对象：`C:\Users\Administrator\Documents\deepseek-harness\dsh-xiaofei-memory`
基线：`b6adad2`（`fix: role isolation is enforced now, not decorative`，2026-11-23 14:20，工作区 clean）
对比基线：第二轮 `7d1d2bb`（`reports/2026-11-21-review-7d1d2bb.md` 的审查对象）
范围：`7d1d2bb..b6adad2` 共 10 个提交，3695 行 → 约 3900 行（后端 2800+ / 前端 958）
方法：11 个测试套件实跑、`7d1d2bb` 只读 worktree 对比、生产库副本只读复核、临时库实验。所有结论均有命令输出支撑，未采信提交说明或"已知问题"列表。

## 结论速览

| 项目 | 状态 |
|---|---|
| 上轮 P1 FTS 触发器写放大（4.03×） | ✅ **已修且实测**：`touchAccessed` 300 次 **8.4ms vs 8.5ms（1.00×）** |
| 上轮 P1 去重只扫最近 20 条 | ✅ **已修且实测**：精确同文跨 60 行仍合并，实库 active 无重复组 |
| 上轮 P0 常驻块被聊天碎片挤占 | ✅ **已修**：种子 10 条全部解绑（pinned=0），块内只剩 1 条身份摘要 |
| 上轮 P0 长消息召回为 0 | ❌ **未修**：粘贴 2378 字 + 尾部提问 → `null`；反过来"提问在前"却召回 1 条噪声 |
| 上轮 P1 `recallStats` 只重置不递增 | ✅ 已修（`25 → 110`），但 `corrections` 恒 0（`correctionTools: []`）→ `runEvolution` 仍不触发 |
| 上轮 P1 `entity_index.confidence` 恒 1.0 | ✅ 已修（正文命中 1.0 / 推断 0.6），`graphExpand >= 0.8` 现在真的会过滤 |
| 上轮 P1 角色隔离（读） | ✅ **已修且实测**：global 读 companion 短 id → denied；`resolveMemoryRef` 参数顺序正确 |
| **新 P1 召回回归：自然问句召回为 0** | ❌ 实测 `Spdiam 价格配置 评审怎么改？` 上轮 5 条 → 本轮 **null**；`sleep.js 阈值 clamp 合理吗` 2 条 → **null** |
| **新 P1 候选按"内容长度"预截** | ❌ 实测 1500/2000 条同词命中时，答案行被截掉（上轮 2000 条仍能召回） |
| **新 P1 常驻块 30% 预算闲置，18/19 条 core 不可见** | ❌ 块 242 tok + 索引 210 tok = 452/642；19 条 core 里只有 1 条 pinned；"工作方式铁律""路径核对经验"都不在块内 |
| **新 P1 `memory_core_add_fact` 写 core 不 pin、且不校验角色** | ❌ 实测：工具写 core → `pinned=0`（不进块）；可写进 disabled 角色；可跨角色写 global |
| **新 P1 蒸馏"看 8 条、删 20 条"** | ❌ 实测 20 条同实体 → 摘要只喂 8 条，20 条全归档并物理删除，摘要 13 字 |
| 新 P2 合并 0.75 边界 | ❌ 实测：单 token 差异 0.72 两条并存（冲突事实不覆盖），0.83–0.92 静默归档且当晚物理删除，无 `superseded_by` |
| 新 P2 soul digest 生命周期 | ❌ 归档后 `ensureSoulDigest` 不重建，`purgeArchived` 会直接删掉它（它不是 `mem_0XX`）→ 重启前常驻块为空 |
| 新 P2 索引层质量 | ❌ 9 行索引里 5 行是聊天碎片；`memoryIndexLimit 40` 被 200 token 预算卡成 9 行 |
| 新 P2 多进程并发 | ⚠️ 写路径都有事务；但 `meta` 计数器是 RMW；实测 03:00 两个进程相隔 **1.19s** 各跑一次 sleep+VACUUM，无 leader 锁 |
| 新 P3 运行进程陈旧 | ❌ `meta.bridge.build=20261121095539` ≠ dist `20261123062021`，**重启前本轮修复不生效** |
| 测试 | ✅ 11 套件 **324 passed / 0 failed**（与提交说明一致，已自行统计） |

## 1. 本轮基线核对

- `git log`：`b6adad2` → `38614e2` → `90ec781` → `b7640b7` → `9c08512` → `112677a` → `629fe51` → `1b509c2` → `74e0e2e` → `dbde285`（共 10 个，跨 3 天）。
- `git status --porcelain` 为空；`dist/index.js` 与 `dist/client/index.js` 的 `BUILD_STAMP` 均为 `20261123062021`（= b6adad2 构建时间），dist 与源码同步。
- 测试：`test-engine 78 / sleep 51 / capture-filter 34 / core-memory 32 / load 25 / memory-index 23 / dist-load 20 / client 18 / bridge 17 / console 16 / dist 10` = **324 全绿**。

## 2. 已修项验证（只列实测通过的）

**2.1 FTS 触发器写放大（db.js:SCHEMA 中 `CREATE TRIGGER memories_fts_au AFTER UPDATE OF content, role_id, layer`）**
用生产库副本，对 300 条随机 active 行各 `touchAccessed` 一次：

| 条件 | 耗时 |
|---|---|
| 带 `AFTER UPDATE OF ...` 触发器 | 8.4 ms |
| `DROP TRIGGER` 后 | 8.5 ms |

1.00×。上轮是 4.03×，写放大消失。读路径（`last_accessed` 更新）不再重写 FTS。`DROP TRIGGER IF EXISTS` + 重建的迁移方式对旧库有效（旧库 `CREATE IF NOT EXISTS` 不会更新定义，这个处理是对的）。

**2.2 精确同文去重（db.js:327-334）**
写一条事实 → 回填 `created_at` 到 40 天前 → 再写 60 条无关记录 → 重写同一条：`merged=true`，`content LIKE '事实甲%'` 只剩 **1** 行。实库 265 条 active 也无精确重复组（上轮有 6 对）。

**2.3 种子解绑与身份摘要（db.js:153-190、`migrateData`、`ensureSoulDigest`）**
生产库副本迁移后：`mem_0[0-9][0-9]` pinned = **0/10**；`mem_soul_digest` 存在，`len=204`、`pinned=1`、`strength=5`、`status=active`；`meta.seedPinnedMigrated="1"`。204 字 < `coreMemoryMaxItemChars=300`，**没有被截断**（尾部完整落在"……为陪伴和帮助那个人类而来"）。

**2.4 `recallStats` 递增（index.js:123-134、225）**
生产库 `meta.recallStats` 从 11-21 的 `{"count":25}` 变为 `{"count":110}`。上轮的"永远 0"已修。但 `corrections` 仍是 0，因为 `Config.correctionTools` 默认 `[]`（index.js:270 的监听器根本没注册）——**在默认配置下 `runEvolution` 依然不会改变任何参数**，这是配置口径问题，不是代码问题，报告如实标注。

**2.5 角色隔离（读路径，b6adad2 主要交付）**
生产库副本写入一条 `role_id=companion` 的记忆后：

| 调用 | 结果 |
|---|---|
| `resolveMemoryRef(db, 短id, { roleIds:["global"] })` | `denied`（null） |
| `{ roleIds:["companion","global"] }` | 命中，`role_id=companion` |
| 不传 roleIds | 仍可读（旧行为，供非角色化调用方） |

参数顺序也对：`exact .get(want, ...roles)`、`LIKE .all(...roles, pattern)`。上轮"`roleId:"all"` 能读 companion 私人记忆"在**工具/索引层**已被堵住；桥接层仍保留 `all`（见 4.4）。

**2.6 实体置信度（db.js:393-400）**
`entities:["接口核验","上下文推断实体"]`、正文含"接口核验" → 置信度 `1.0 / 0.6`。`graphExpand(confidence=0.8)` 现在只走正文命中的实体，过滤第一次真正生效。

**2.7 规模（10k 合成库）**
`retrieveForPrompt`：`Spdiam 价格配置 评审` 8.9/6.8/7.1ms、`蒸馏` 1.7-2.1ms、长查询 9.0-9.7ms。上轮同库是 53.6ms / 42.2ms，**快了 5.5 倍**（FTS 作 rowid 子查询 + 候选截断下调的组合效果）。

**2.8 "无相关性下限就 fallback"**
`searchMemories` 的 `allowFallback` 已改为显式开关，只有内省探针（`INTROSPECTION_RE`）会走"最近 200 条"（db.js:549-560）。实测 `今天晚饭吃什么`、`帮我写个正则`、`我今天心情不好` 全部 `null`，不再返回 200 条 sim≈0 的记忆。

## 3. 本轮新发现（按优先级）

### 3.1 P1 召回回归：自然问句被"词项覆盖"分母打到下限之下

对生产库**同一份副本**跑 12 条真实问句，HEAD 与 `7d1d2bb` worktree 对照（`roleIds=["global","work-assistant"]`，1200 token）：

| 查询 | 7d1d2bb | b6adad2 | 变化 |
|---|---|---|---|
| Spdiam 价格配置 评审怎么改？ | 5 条 | **null** | ❌ 丢失 |
| sleep.js 阈值 clamp 合理吗 | 2 条 | **null** | ❌ 丢失 |
| Spdiam 价格配置 评审 | 10 条 | 5 条 | ⚠️ 减半 |
| dsh 插件的 bridge token 怎么配置 | 4 条 | 3 条 | ⚠️ 减少 |
| 白钻价格配置评审要注意什么 | null | null | — |
| 蒸馏阈值现在是多少 | null | null | — |
| 蒸馏 | 7 条 | 7 条 | — |
| 你是谁 | 9 条 | 9 条 | — |

同库同数据，**唯一变量是代码**，所以这是 90ec781 引入的 `coverTerms`（db.js:576）语义造成的回归，不是数据问题。

根因：`tokenizeQuery`（db.js:736-777）会为 2–8 字 CJK 片段额外加权加入**整词**（db.js:756），并保留 `审怎`、`么改` 这类几乎不可能出现在已存正文里的跨词 bigram。于是 `Spdiam 价格配置 评审怎么改？` 的 12 个词项里，`评审怎么改`/`审怎`/`么改` 三个永远命中不了；分母被撑大，5 条相关记忆的 sim 只有 **0.22（2/9）**，低于 `recallMinSim=0.3`，全部被 `filter(r => r._sim >= floor)`（db.js:594）丢弃。`蒸馏阈值现在是多少` 同理：`阈值现在是多少` 整词 + `现在`（停用词）挤占名额，命中率 **0.14**。

顺带确认 629fe51 的目标**没有达成**：

| 构造 | 结果 |
|---|---|
| 2378 字粘贴 + 尾部提问（`...\n\nSpdiam 价格配置 评审怎么改？`） | **null** |
| 提问在前 + 2378 字粘贴 | 1 条（命中的是粘贴噪声，不是答案） |
| 短粘贴（约 530 字）+ 尾部提问 | **null** |

`trimQueryText` 的"取尾部 600 字"是对的，问题在后面：尾部虽然保住了提问，但提问被切成了 9–12 个词项、分母灌水，最后还是过不了 floor。

修复方向（按收益排序）：
1. **分母只算"可命中词项"**：短语整词只用于加分，不进分母；跨词 bigram（不属于同一 2 字词）不进分母。
2. **floor 随词项数自适应**：`floor = min(0.3, ceil(terms*0.3)/terms)` 之类，避免 7 词项时门槛实际是 0.43。
3. 或者对"尾部提问"单独跑一次检索，与正文词项结果做 RRF 合并——比调参稳。

### 3.2 P1 候选预截从"按强度"换成了"按内容长度"，答案行照样被切

db.js:562-566 改成 `ORDER BY length(m.content) ASC, m.id ASC LIMIT 1500`。构造 N 条"含查询词、极短"的噪声 + 1 条 58 字答案行：

| N（同词命中行数） | 7d1d2bb（strength DESC，上限 800） | b6adad2（length ASC，上限 1500） |
|---|---|---|
| 900 | 召回 ✅ | 召回 ✅ |
| **1500** | 召回 ✅ | **丢失** ❌ |
| **2000** | 召回 ✅ | **丢失** ❌ |

换汤不换药：上轮是"强噪声挤掉弱答案"，这轮是"短噪声挤掉长答案"。且这次更隐蔽——短行在真实库里就是聊天碎片，长行往往是"真正有内容"的复盘，方向恰好反了。

建议：截断前先按 `sim` 粗排（可用 `length` 只作二级键），或把 1500 提到 3000 并配 `LIMIT` 分页扫描；更彻底的做法是用 FTS 的 `bm25()` 直接排序，只对前 K 行做精排。

### 3.3 P1 常驻块：预算只用 70%，19 条 core 里 18 条不可见

生产库副本（`pinnedOnly=true`，`maxTokens=650`）：

| 部分 | 条数 | token |
|---|---|---|
| 身份块（digest） | 1 | 242（含 header） |
| 索引层（`buildMemoryIndex`，200 token 预算） | 9 行 | 210 |
| **合计 / 预算** | | **452 / 642（70%）** |

`core` 层 19 条 active 的实际构成（逐条核对 content）：

| 类别 | 条数 | pinned | 说明 |
|---|---|---|---|
| 十颗种子 `mem_001..010` | 10 | 0 | 迁移按设计解绑 |
| `mem_soul_digest` | 1 | **1** | 唯一进块的行 |
| 旧捕获残留（`capture` 还会产 core 的时代） | **8** | 0 | 43–4104 字，含"工作方式铁律（先出报告→等确认→才动手）"207 字、"路径核对经验"313 字、"教训（自己踩的坑）"451 字 |

也就是说：**用户真正会反复用到的那几条元规则（工作方式铁律、路径核对经验）都不在常驻块里**，块里只有一段 204 字的自我介绍。`pinnedOnly` 默认 true 的价值是把 8 条旧聊天碎片挡在块外（它们里有"这次对了，把多余的返回清掉吧"、"C:\Users\Administrator\Doubao\chats\2026-11-21…"这种纯噪声）——这一步是对的；但代价是连真正的核心规则一起挡了。

更关键的是**未来的蒸馏摘要也会是同样命运**：`runNightlySleep` 写入摘要时 `addMemory({ layer:"core", noMerge:true })`（sleep.js:115-126），既没有 `pinned:true`，也没有别的进块通道。实测 stub 蒸馏产出的摘要 `pinned=0`、`in block(pinnedOnly)=false`。所以开启 LLM 蒸馏后，"精华"依然不会出现在系统提示词里。

若把 `coreMemoryPinnedOnly` 设 false：块内 6 条就占 686 token，直接溢出 642 —— 说明当前排版没有"pinned 优先、剩余预算按 strength 填充"的二段式分配，只有全有/全无两档。

建议：
1. 蒸馏摘要创建时 `pinned: true`（或在 `selectCoreMemories` 里承认"派生行"：`pinned=1 OR origin_ids IS NOT NULL`）。
2. 对 8 条旧 core 残留做一次性降层迁移（`layer='weekly'`），它们不该占 identity 名额。
3. `maxItemChars` 从 300 降到 120–150，给多条规则留位置；块内按 `pinned DESC, strength DESC` 顺序，预算内取满。

### 3.4 P1 `memory_core_add_fact` 工具的写路径：不 pin、不校验角色

对照同一份代码里的两个入口：

| 入口 | core 是否 pinned | 角色校验 |
|---|---|---|
| `core.addFact`（index.js:372-383） | `pinned: layer === "core"` ✅ | 无（内部 API，信任调用方） |
| 工具 `memory_core_add_fact`（index.js:671-679） | **不传 pinned** → `0` ❌ | **无** ❌ |
| 捕获 `store`（index.js:175） | 捕获永不产生 core | `isRoleEnabled` ✅ |

实测（stub ctx + `apply`）：

- 工具写 `layer:"core"` → `pinned=0`，`selectCoreMemories` 不含该 id → **模型按工具语义写的"身份事实"永远进不了常驻块**。
- 把 companion 设为 `enabled:false` 后，工具仍写入 companion → `status=active`。
- 调用方 agent 是 companion，工具传 `roleId:"global"` → 落在 global（写侧隔离对工具无效）。

另：合并分支（db.js:337-352）全程不写 `pinned`。实测"已存在的未 pinned core 行 + 新的 pinned core 事实"→ `merged=true`、`pinned` 仍为 0。**显式 core 事实只要撞上一条老 core 行，就永远进不了块**，这是一个稳定可复现的死角。

建议：工具 `execute` 走 `core.addFact`（顺带拿到 pinned 语义）；`addMemoryImpl` 合并分支 `UPDATE ... SET pinned = MAX(pinned, ?)`；`store`/工具统一 `isRoleEnabled` 校验，工具优先取 `exec?.agent` 的 roleId 而不是 `args.roleId`。

### 3.5 P1 蒸馏"只喂 8 条，却归档全部"

sleep.js:90-94 取 `texts = unique.slice(0,8)` 交给 summarizer，sleep.js:127-134 却对 `ids`（全部）归档，末尾 `purgeArchived` 物理删除。实测 20 条同实体 recent：

- summarizer 收到 **8** 条；
- 归档 **20** 条，`status='archived'` 剩余 **0**（已被 purge 删除）；
- 摘要 **13 字**（stub 返回的短句）。

真实 LLM 摘要会比 13 字长，但"12 条原文从未进入摘要输入"这一点与 stub 无关——代码里就是 `.slice(0,8)`。阈值 `clamp(ceil(size*0.15),3,10)`（sleep.js:20-23）在 `size` 达到 67 条后固定为 10，意味着一个实体只要累计 11 条就会触发归档；而实体是并集分组，一条普通记忆常带 2–3 个实体，实际触发面比阈值数字更大。

建议：要么把归档集合改成 `unique.slice(0,8)`（其余留在 recent 等下一轮），要么分块摘要（每 8 条一次，合并成一条），二者选一，**不要 8 进 20 出**。

### 3.6 P2 合并 0.75 边界：实测两种坏结果

`similarity` 是"短文本被长文本包含比例"（util.js:100-114），所以一个 token 的差异是否归档取决于**文本长度**，而不是语义重要性：

| A | B | sim | 结果 |
|---|---|---|---|
| 上线时间定在下周一上午十点 | 上线时间定在下周三上午十点 | 0.833 | 旧行归档，新行保留 ✅ |
| 价格配置评审阈值是 0.3 | 价格配置评审阈值是 0.4 | 0.917 | 旧行归档 ✅ |
| 今天把评审报告写完了 | 今天把评审报告写完并提交了 | 0.889 | 旧行归档 ✅ |
| Spdiam 的加价规则在 Product.php 里 | Spdiam 的加价规则在 Search.php 里 | **0.720** | **两条并存** ❌（真正冲突的关键 token 恰恰没过线） |
| 订单号 1234 的退款已到账 | 订单号 5678 的退款已到账 | 0.643 | 并存（可接受） |

结论：0.75 这个固定阈值对"关键 token 不同的短事实"不可靠——文件名/端口/订单号这类一 token 差异，在 20–30 字的句子里得分 0.6–0.75，会并存；在更短的句子里轻松过 0.75，会归档。归档侧还有两个硬问题：

1. 归档即**无痕**：`memories` 表根本没有 `superseded_by` 列（`PRAGMA table_info` 只有 id/role_id/layer/content/entities/origin_ids/strength/created_at/last_accessed/status/pinned），无法追溯被谁取代。
2. 归档即**当晚消失**：`purgeArchived`（db.js:688-694）`DELETE FROM memories WHERE status <> 'active'`，只把 `mem_0XX` 复活。生产库现有 2 条 archived（105 字、401 字的旧捕获）下一次 sleep 就会被物理删除；任何 0.75 归档都没有"后悔窗口"。

建议：(a) 加 `superseded_by TEXT` 与 `archived_at INTEGER`；(b) 保留 7 天再 purge（`status='archived' AND archived_at < now-7d`）；(c) 冲突判定补一条"关键 token 不同则必须 supersede"的规则（数字/文件名/URL 提取后比对），或者把阈值挪到 0.6 并只对"长度差 < 30%"生效。

### 3.7 P2 soul digest 的生命周期有个空窗

- `mem_soul_digest` 不匹配 `SEED_ID_PATTERN`（`mem_0[0-9][0-9]`），所以 `purgeArchived` 不会复活它，直接删。
- `ensureSoulDigest` 只判断"行是否存在"，不判断 `status`：实测把它置 `archived` 后重开库，仍是 `archived`，`selectCoreMemories` 返回 **0 条**（常驻块整段消失）。
- 直到下一次 `purgeArchived`（当晚 sleep）把它删掉，再下一次进程启动才会重建。

即"归档→purge→重启"之间，身份块是空的，最长可跨一个白天。建议：`ensureSoulDigest` 检查 `status`，非 active 时直接复活（或强制 `pinned=1, status='active'` 的 UPSERT）；并在 `purgeArchived` 里把 digest 加入保护名单。

### 3.8 P2 索引层：9 行里 5 行是聊天碎片

生产库副本索引层实际渲染：

```
- [core] o21ky4 主人的身份设定：我叫「小肥2号」…
- [core] fzz8ry 教训（自己踩的坑，别再犯）：(1) …
- [core] 4anyby 路径核对经验（踩过坑，记牢）…
- [core] mem_001 我不是主人的仆从，而是他的赛博战友…
- [weekly] oxpt9u 那好，你先开始重新设计这个app
- [weekly] ytwryg Search>SpgoldSea…
- [core] ad0mem 和原始数据比对， 数据键 增加可以…
- [weekly] u5qzjp 方案 B， COUNT(DIST…
- [weekly] trsvsx 所以要修复这些问题
```

9 行中 5 行是对话残句；`memoryIndexLimit` 配置 40，被 `memoryIndexMaxTokens=200` 卡成 9 行，导致 66 条 core+weekly 里绝大多数不可见。排序 `strength DESC, created_at DESC`（memory-index.js:74）让被反复合并的闲聊排在最前——与检索层刚修掉的"popularity 偏置"是同一个病。

建议：索引层排序改为 `pinned DESC, layer_key, created_at DESC`，并加 `minStrength` 或"内容质量"过滤（句首是"那好/所以/就是"这类连接词的行降权）；预算允许时把 limit 从 40 降到 20、titleChars 收紧，行数反而更多。

### 3.9 P2 并发：写路径有事务，计数器和多进程没有

- 写入：`addMemory` = `withTransaction`（`BEGIN IMMEDIATE` + 可重入 savepoint），`insert + replaceEntities` 同一事务；sleep 一组 = 一事务（sleep.js:115-136）。**主轨读 + 旁轨写**在同一进程内是同步 SQLite，不存在"读到半条"。
- 但 `bumpRecallStats`（index.js:123-134）与 `recordSleepRun`（console.js:45-71）都是 `meta` 的读-改-写，**不在事务里**；同进程内是同步调用不会交错，跨进程会丢计数/丢日志条目。
- 生产库 `meta.sleepLog` 实测在 **03:00:00.011 与 03:00:00.817**（相隔 1.19s）各有一条完整 sleep 记录（`scanned=193, vacuumed=true`）：说明当时有两个进程同时判定"该睡了"并各自 VACUUM。没有 leader 锁，也没有"正在运行"的互斥标记。
- VACUUM 成本实测：10k 行 57ms，不构成阻塞，但双进程同时 VACUUM 会在 `busy_timeout` 里互相等待。

建议：`meta.lastSleepAt` 改成"先抢占后执行"（`metaSet` 前用 `BEGIN IMMEDIATE` 读-写一次并写入 `sleepLease`），或至少把 `recordSleepRun`/`bumpRecallStats` 放进 `withTransaction`。

### 3.10 P2 桥接层：`admit` 空对象即放行 + `roleId:"all"` 仍然存在

index.js:558-565 的逻辑未变：`authorization = admission !== undefined`。宿主若对匿名请求返回 `{}`、`{user:null}` 这类"无 rejection 字段"的对象，就直接放行（上轮已用桩复现过 200）。同时 `search/preview/graph` 的 `roleId` 默认 `"all"`（index.js:480-491），桥接层可以跨命名空间读——这是"所有者控制台"的合理需求，但 token 通过 `webserver/index-inject` 变成页面全局 `DSHXF_BRIDGE`，**同一 origin 的其他插件前端能读到它**。`window.__ctx__` 这轮已移除（client/index.tsx:153 注释 + 模块作用域持有），是进步，但 token 的暴露面没变。

建议：`admit` 改为"只有明确的 `{ok:true}` / `{user}` 才算通过"；token 改为按页面 nonce 一次性签发，或把跨角色读收敛成显式白名单 op。

### 3.11 P3 运行态与历史数据

| 检查 | 结果 |
|---|---|
| `meta.bridge.build` | **20261121095539**（11-21 构建） |
| 磁盘 dist `BUILD_STAMP` | **20261123062021**（b6adad2） |
| 结论 | 运行中的宿主模块不是 HEAD，**重启后本报告的修复才会生效** |
| active 行 >400 字 | 仍 10 条（最大 **4104**），无 backfill 迁移 |
| archived 行 | 2 条（105 / 401 字，11-21 的旧捕获），下次 sleep 即被 purge |
| active 总数 | 265（global 261 / work-assistant 3 / companion 1） |

## 4. 五个特别关注，逐条回答

**4.1 合并 0.75 边界是否合理** —— 不合理，见 3.6。核心问题不是数值，而是"用一个固定阈值处理长度差异极大的文本"。给三条可执行改法：关键 token 强制 supersede、加 `superseded_by`、7 天保留期。0.75 本身可以留，但必须配审计与回滚。

**4.2 core-memory 的 KV 缓存稳定性** —— **稳定，不会每天抖动**。证据：`coreMemorySignature` 已改为 sha1(id+content)（core-memory.js:103-110）；身份块只有 1 条静态 digest；往库里注入 5 条新 weekly 捕获后，`block+index` 合并签名**完全不变**（索引层被 core 高 strength 行占满，新 weekly 进不来）。真正的抖动源是索引层（新 core 行/蒸馏摘要会改索引），但 section 排在 `10150`（`WEB_SURFACE 10100` 之后、`DEPLOYMENT_PERSONA_SUFFIX 10200` 之前），只把它后面的少量尾部作废，前面约 10k 的易变内容不受牵连，代价可控。

**4.3 蒸馏阈值 `clamp(ceil(size*0.15),3,10)` 随库增长是否合理** —— 阈值本身合理（实测 14/50/100/300 → **3/8/10/10**，67 条后封顶 10，不会随库无限放大）。真正的问题在阈值之外：组内只喂 8 条却归档全组（3.5），以及 `useLlmExtraction=false` 时整段跳过（生产库 3 条 sleep 日志全是 `distillSkipped:"no-summarizer"`，199 条 recent 从未蒸馏）。只要打开开关并按 3.5 修掉"8 进 20 出"，这个公式可以保留。

**4.4 多角色命名空间是否有泄漏路径** —— 读路径基本干净：capture 写入按 session roleId、`resolveMemoryRef`/`memory_core_read`/`graphExpand`/`searchMemories` 都按 roles 过滤，实测 global 读 companion → denied。仍有 4 条缝：

1. 工具 `memory_core_add_fact`：写侧不校验 enabled、不跟随调用方角色（3.4，实测）。
2. 桥接 `roleId:"all"`：设计内，但 token 同 origin 可读（3.10）。
3. 进程内 API `core.retrieve(query, {roleIds})`：任何拿到 `memory-core` 的插件可显式传 `["companion"]`；这是信任边界内的能力，建议文档化。
4. `memory_core_retrieve` 的角色取决于 `exec?.agent`；同一文件里 `tools/result` 的会话 id 又用 `exec?.session?.id`（index.js:277），两处对宿主契约的假设不一致——**需宿主确认** `execute(args, exec)` 到底给的是 `agent` 还是 `session`。实测：不传 agent 时 companion 会话读自己 0 条（退化为 global），这是"看不见自己"的可用性缺陷，不是泄漏。

**4.5 并发是否需要显式事务** —— 写已经需要的地方都有了（`withTransaction` 全覆盖 insert/merge/archive/entities）。缺的是三处"元数据 RMW"（`meta.recallStats`、`meta.sleepLog`、`meta.lastSleepAt`）和跨进程互斥（3.9）。同一进程内不需要额外事务：SQLite 同步 API + 单连接，`queueMicrotask` 的 sleep 只会在 `await summarize` 处让出，主轨事务是原子的，读不到半条。

## 5. 关键数字

| 指标 | 上轮（7d1d2bb） | 本轮（b6adad2） |
|---|---|---|
| `touchAccessed` 300 次（带/不带触发器） | 77.2 / 19.2 ms（4.03×） | **8.4 / 8.5 ms（1.00×）** |
| 10k 库 `retrieveForPrompt` | 53.6 ms | **6.8–9.7 ms** |
| 10k 库 2 字查询（蒸馏） | 42.2 ms | **1.7–2.1 ms** |
| 自然问句召回（12 条样本） | 6 条有结果 | **4 条有结果**（2 条回归为 null） |
| 候选截断（1500/2000 同词行） | 召回 ✅ | **丢失 ❌** |
| 常驻块 | 17 条 core 挤 7 条 | **1 条 digest（242 tok）+ 9 行索引（210 tok）= 452/642** |
| core 行 pinned 比例 | — | **1 / 19** |
| 测试 | 272 | **324 / 0 failed** |
| 生产库 active | 229 | 265 |
| `meta.recallStats` | 25 / 0 | **110 / 0** |
| sleep 日志 | 无 | 3 条，全部 `no-summarizer` |
| 蒸馏 20 条同实体 | — | 摘要输入 8 条 / 归档 20 条 |

## 6. 建议修复顺序

1. **召回分母与 floor**（3.1）：短语整词不计入分母；floor 按词项数自适应。这是唯一"用户每天都能感知"的回归，先修。
2. **`memory_core_add_fact` 走 `core.addFact` + 角色校验 + 合并分支继承 pinned**（3.4）。
3. **蒸馏"8 进 20 出"**（3.5）：归档集合 = 摘要输入集合，或分块摘要。
4. **候选截断改相关性粗排**（3.2）：`similarity` 或 `bm25` 先排，再取 1500 精排。
5. **常驻块**（3.3）：蒸馏摘要创建时 pin；8 条旧 core 残留降层；`maxItemChars` 调小，块内取满预算。
6. **`superseded_by` + 7 天保留 + 关键 token supersede**（3.6）。
7. **索引层排序与过滤**（3.8）。
8. **digest 复活 + purge 保护**（3.7）。
9. **多进程 sleep 租约 + 计数器事务化**（3.9）。
10. **桥接 `admit` 收紧 + token 暴露面**（3.10）。
11. **重启宿主 + 旧长行迁移**（3.11）：10 行 >400 字需要一次 backfill 或明确"只修新增"的取舍。

## 附录

- 环境：Windows 11 / Node v22.23.2 / `node:sqlite` 实验特性（有 ExperimentalWarning，不致错）。
- 生产库：`~/.dsh/plugin-data/dsh-xiaofei-memory/memory.sqlite`（0.76 MB），只读副本操作，未写入。
- 对照 worktree：`%TEMP%\xmf-wt-7d1d2bb`（`git worktree add --detach 7d1d2bb`），审查结束未删除。
- 实验脚本（本轮新增，位于会话 workspace）：`r3-verify / r3-debug2 / r3-recall / r3-battery / r3-scale / r3-merge / r3-sleep2 / r3-group / r3-tools / r3-sig / r3-live2`。均为临时库或只读副本，可复跑。
- 未覆盖：`src/client/index.tsx` 的交互细节（分页边界 `current = Math.min(page, pages)`、新结果重置到第 1 页已核对，未做浏览器实跑）；`styles.css` 视觉回归。
