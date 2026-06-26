# 模拟面试：多 Agent 旅行规划器

> 以递进追问形式覆盖项目全部技术深度。每节从面试官常见开场问题出发，逐步深入。

---

## 1. 项目概述

**Q: 一句话介绍？**

多 Agent 协作的智能旅行规划系统 — 用户多轮对话输入偏好，系统自动搜索航班/酒店/景点/餐厅等真实数据，LLM 生成完整每日行程，全程 SSE 流式推送。

**追问：为什么选多 Agent 架构而不是单模型一次生成？**

1. **数据实时性** — 航班价格、酒店房态、天气实时变化，必须对接真实 API
2. **可靠性** — 每个 Agent 职责单一，单个失败不阻塞整体，有降级兜底
3. **可控性** — 每步输入输出结构化，可追踪可复盘，不会出现"不知道 LLM 为什么推荐了这个酒店"

---

## 2. 架构演进：Pipeline → Agent Loop（核心）

**Q: 现在有两套架构，分别是什么？**

**老架构 Pipeline（默认）**：6 个领域 Agent 线性编排。FlightAgent + HotelAgent `Promise.allSettled` 并行执行（无数据依赖），LLMPlanAgent 顺序执行（依赖前两者结果），BudgetAgent 核验预算。超预算通过 `searchConstraints` 重新搜索真实低价，最多 3 轮。

**新架构 Agent Loop**（`USE_AGENT_LOOP=true` 启用）：ReAct 风格 Agentic 主循环。代码控制 Loop 主体，LLM 每轮返回单步决策（调用哪些工具）。5 phase（gathering→searching→selecting→planning→completed），phase 转换纯代码硬条件判定，LLM 只能决定"调哪些工具"，不能决定"进入哪个 phase"。

**追问：为什么 Agent Loop 效果不如 Pipeline？**

三个根因：

1. **LLM 工具选择不稳定** — Pipeline 里"搜航班→搜酒店→排行程"写死了。Agent Loop 里 LLM 自主选工具，时有遗漏（忘搜返程交通、忘搜餐厅），数据不全后续质量就差
2. **ReAct 多轮累积延迟** — Pipeline 直线执行 ~20s。Agent Loop 每轮都要 LLM 决策+工具执行+结果回传，总延迟 40-60s
3. **上下文膨胀** — 每轮工具结果 push 进 message history，planning 阶段开始时 messages 已很长，LLM 注意力分散

**追问：既然效果不好为什么保留？**

1. **对照基准** — 每次 prompt 优化后快速 A/B 对比
2. **技术储备** — `<thought>` 标签、结构化 trace、JSON 自修复等机制可复用
3. **特定场景** — 探索性强的需求（"我不知道去哪，帮我找找"）Agent Loop 的自主性有优势

---

## 3. Agent Loop 技术细节

**Q: 5 个 phase 怎么推进的？**

纯代码硬条件，不靠 LLM：

| 转换 | 条件 |
|------|------|
| gathering → searching | preferences 6 必填字段齐全 |
| searching → selecting | candidateTransports > 0 && candidateHotels > 0 |
| selecting → planning | selectedOutbound + selectedReturn + selectedHotel 全部就绪 |
| planning → completed | dayPlans 天数 = 旅行天数 && budgetBreakdown 存在 |

`maybeAdvancePhase(state)` 在每轮 Loop 末尾执行，不满足条件留在当前 phase。

**追问：selecting 阶段有个红线设计？**

`select_transport` 和 `select_hotel` 的 `allowedPhases` 设为 `[]`。LLM **在任何阶段都不能调用这两个工具**。用户选择只能通过前端 `/api/chat/:sid/select` API 注入，由 `applyUserSelection()` 写入 state。借鉴了 Claude Code 的安全原则——花钱/产生外部效果的操作不能由 LLM 自主决定。

**追问：`<thought>` 标签是做什么的？**

强制 LLM 每次决策前输出推理：

```
<thought>
phase=searching, 已有目的地东京 + 预算15000 + 偏好Comfort。
下一步需要并行获取景点/酒店/小红书真实评价。
调用 search_attractions + search_hotels + search_xhs。
</thought>
```

`parseThought()` 正则提取后写入 `state.lastThought` + trace。让"LLM 为什么调这个工具"完全可观测。

**追问：LLM 反复调同一工具不推进 phase 怎么办？**

`staleCount` 机制：phase 没推进就 +1，达 `MAX_STALE_ITERS(10)` 后 force stop。各阶段有备选终止文案（"检索工具均返回空数据" / "行程编排未完成"）。

**追问：JSON 自修复怎么做的？**

三层防御：
1. 正则提取最外层 `{...}`
2. `JSON.parse` + Zod schema 校验
3. `jsonrepair` 修复语法错误（尾逗号、缺括号、单引号）

三层都失败 → 错误+原文末尾 300 字符回传 LLM 修复，maxRetries=3，仍失败抛 `JsonRepairExhaustedError`。

注意 jsonrepair 只修语法，不修语义——字段缺失、类型错误靠 Zod + LLM 重试。

---

## 4. 数据源链路

**Q: 对接了多少数据源？**

| 数据源 | 用途 | 实现 |
|--------|------|------|
| 携程航班 | 航班低价查询 | REST API |
| Booking.com | 酒店搜索 | RapidAPI |
| 高德 POI | 景点/餐厅/公交路线 | Web API |
| 高德天气 | 实时+预报 | Web API |
| 12306 | 火车票查询 | JSON-RPC over stdio (MCP) |
| 小红书 | 真实旅行笔记 | Python 微服务 (curl_cffi 反爬) |
| Web Search | 搜索引擎降级 | 百度>sogou>Bing>Firecrawl |
| RAG 攻略 | 语义检索 | 向量搜索+关键词兜底 |

**追问：降级机制怎么设计的？**

两层：

1. **FallbackDataSource 包装器** — 主源失败/空 → WebSearch → 仍失败返回空数组
2. **Tool 级降级链**（Agent Loop 的 `TOOL_FALLBACK_CHAIN`）：

```
search_xhs: xhs_service(L0) → web_search_site_filter(L1) → rag_travel_guides(L2)
search_restaurants: amap_poi(L0) → xhs_service(L1) → web_search(L2) → rag_travel_guides(L3)
```

trace 记录 `fallback_level`，复盘时一眼看出降级比例。

**追问：12306 MCP 怎么对接的？**

subprocess 启动 Python 脚本，JSON-RPC over stdio。每行一个 JSON 请求/响应，进程常驻复用。MCP 简化版——不在 Node.js 里调 Python，通过标准输入输出做跨语言 RPC。

**追问：高德 API QPS 限制怎么处理？**

`TokenBucket`（capacity=3, refill=3/s）。所有高德相关工具统一过 `amapLimiter.acquire()`。planning 阶段一天搜多次餐厅时加结果缓存（`景点+mealType → 餐厅`，TTL 5min）。trace 记 `amap_wait_ms`，>2s 触发告警。

---

## 5. Pipeline 执行细节

**Q: Pipeline 各 Agent 怎么协作的？**

```
UserPreferences
  → PreferenceAgent (校验)
  → enrichDestination (LLM 生成目的地百科)
  → refreshSelectedPrices (价格漂移校验，>10% warning)
  → BudgetLoopController (最多 3 轮):
       ├─ Promise.allSettled([FlightAgent, HotelAgent])  ← 并行
       ├─ LLMPlanAgent (依赖前两者)                    ← 顺序
       └─ BudgetAgent (汇总 → 超预算 searchConstraints 重搜)
  → ActivityAgent (LLMPlanAgent 失败时降级兜底)
  → TravelPlanState
```

**追问：为什么 Flight + Hotel 可以并行？**

无数据依赖。`Promise.allSettled` 同时执行，各 120s 超时，延迟降低 40-50%。LLMPlanAgent 必须在之后顺序执行——需要航班价格和酒店价格来分配每日预算。

**追问：预算超限怎么处理？**

`BudgetAgent.computeConstraints()` 按超支比例生成约束：
- 超支 < 20% → 酒店降价 20%
- 超支 20-50% → 酒店+航班各降 20%
- 超支 > 50% → 酒店降 40% + 航班降 30%

约束通过 `searchConstraints` 传回，带 `maxPrice` 参数重新调数据源。**不是纸面降价，是重新搜索真实低价。** 最多 3 轮，仍超则带 warnings 完成。

**追问：价格漂移校验是什么？**

用户选航班到 Pipeline 执行可能间隔数十秒，价格可能已变。`refreshSelectedPrices` 重新查价，偏差 >10% 生成 warning + 更新价格。校验失败不阻塞 pipeline。

**追问：LLMPlanAgent 超时/失败怎么办？**

自动降级到 `ActivityAgent`（纯算法式规划：调高德 POI → 按 morning/afternoon/evening 分配 → Haversine 距离算交通）。餐厅 API 也失败时 fallback 固定餐费（早¥30/午¥60/晚¥80）。ActivityAgent 也失败记录错误继续返回，不阻塞整体。

**追问：LLMPlanAgent 的 checkpoint 机制？**

`PipelineExecutor` 有超时重试。LLMPlanAgent 如果在 ReAct 第 8 轮超时，重试不能从第 0 轮开始（浪费 token）。每轮把 `{messages, toolCallHistory, totalToolCalls, round}` 写入 `state.llmPlanCheckpoint`。重试时 `structuredClone(state)` 拍快照，从 checkpoint 续行。

---

## 6. RAG 攻略检索（核心亮点）

**Q: RAG 管道怎么建的？**

```
129 份 PDF（全国 15 地区）
  → pdf-parse 提取文本（后续发现 PDF 字符编码 bug，换成 PyMuPDF）
  → 三级分块：## 标题 → \n\n 段落 → 滑窗
     参数：maxChars=500, overlap=80, minChars=100
  → ~7,400 chunks（清洗后，原始 9,432 剔除 22% 噪声）
  → embedding-3 (智谱, 2048 维) + BM25 混合检索
  → MemoryVectorStore (cosine similarity)
```

搜索链路：embedding 向量分 ≥ 0.3 → BM25 hybrid 融合；< 0.3 → 纯 BM25 关键词兜底。

**Q: 既然是 RAG，为什么要做 5 轮实验？**

这是整段经历里最有价值的工程故事。RAG 实验跑了 5 轮、7 个 variant（V0-V6），中间踩了 5 个评测系统缺陷 + 3 个数据质量 bug：

**追问：踩了什么坑？**

**前三轮实验全部建立在错误数据上：**

1. **Embedding API 静默失败** — `.env` 缺少 `RAG_EMBEDDING_*` 配置，fallback 到不支持 embedding 的端点，API 返回 400，embedder 静默返回空向量 `[]`。**前 3 轮实验的"向量搜索"其实全部走的是纯 BM25 关键词匹配**，向量搜索从头到尾没参与。

2. **City filter 字段命名不一致** — Store 里 `metadata.city="成都攻略"`，eval query 里 `city="成都"`，严格相等匹配导致成都 20 条 query 全部 0 命中。**前三轮 V0=61%/V3=67% 的数据里有 20pp 是被这个 bug 吃掉的。**

3. **eval 失败索引错位** — `results.filter(r => !r.hit10).map((_, i) => queries[i].id)` 的 `i` 是过滤后数组索引，但 `queries[i]` 取原数组。导致失败分布报告长期失真——成都明明全失败，报告显示全过。

4. **PDF 文本提取字符错误** — `pdf-parse` 解码自定义字体 CMap 时 "不"→"丌"、"于"→"亍"、"的"→"癿" 等 20+ 个字符系统性错误。存储的内容是 "丌知道明夛会収生互什么"，语义已被破坏。

5. **NDCG 计算实现错误** — 把 100 条 query 的二元 hit 数组当 top-K relevance list 喂进 DCG，NDCG 恒为 1.0。

**追问：怎么发现的？怎么修的？**

用户一句话"明明有成都攻略却搜不出来"比任何评测指标都准。实地调查 store → 发现 city 命名不一致 → 顺着往下挖出 eval bug + PDF 噪声 + embedding 不工作。

修复顺序（按 ROI）：
1. 修 `failedQueries` 索引（`flatMap` 替代 `filter.map`）
2. City filter 改 `startsWith` 模糊匹配
3. PDF 文本提取切 PyMuPDF + `str.maketrans` 修正表
4. 清洗 store：删 `-- N of M --` PDF 分页符 + chunk 头重复前缀 + 长度<20 的纯噪声 chunk（9,432 → 7,312 条）
5. 配置 embedding API（智谱 `/paas/v4/embeddings`）

**追问：修完后效果？**

| 阶段 | V0 Hit@5 | 说明 |
|------|----------|------|
| 修复前（纯 BM25） | 67% | 向量没工作，且 city bug 吃掉 20pp |
| 修复后第一轮 | **86%** | +19pp，主要来自数据修复，不是算法改进 |
| 最终（PyMuPDF 重提） | **85%** | 持平，检索不受字符修复影响，但生成质量大幅提升 |

**追问：7 个 variant 实验结果？**

| Variant | Hit@5 | vs V0 | 结论 |
|---------|-------|-------|------|
| V0 (向量+BM25 fallback) | 86% | baseline | — |
| V1 (chunk=300) / V2 (chunk=1500) | 37% | **-49pp** | 现有语料粒度太小(100-155字)，rechunk 后结构破坏 |
| V3 (BM25 hybrid + 向量 fallback) | 86% | 持平 | **MRR +1.8pp (p<0.0001)**，NDCG +3.8pp → 采纳为默认 |
| V4 (MMR 多样性重排) | 85% | -1pp | 重排不改召回，在此场景无效 |
| V5 (LLM 扩展 + 向量) | 84% | -2pp | 延迟 26 倍 (2.7s vs 105ms)，显著变差 |
| V6 (LLM 扩展 × BM25) | 83% | -3pp | 延迟 24 倍，显著变差 |

**最终默认 variant = V3**。Hit@5=86%, MRR=0.765, NDCG@10=0.48, P95=115ms。契约目标 Hit@5≥85% 达成。

**追问：最大的教训是什么？**

1. **评测系统本身的 bug 是最隐蔽的失败模式** — 前三轮所有归因（"瓶颈在 embedding 召回""重排策略无效"）都建立在错误数据上。修复后发现真正的瓶颈是数据质量，不是算法。
2. **用户直觉比评测指标更准** — "明明有数据却搜不出来"这种实地观察，比 100 条 eval 的聚合指标更快定位根因。
3. **LLM 扩展路径（V5/V6）在当前阶段 definitively 无价值** — 延迟代价 24-32 倍，Hit 反而显著变差。干净数据下原 query 足够好，LLM 扩展反而稀释关键词权重。
4. **数据基建 > 算法调优** — +19pp 的提升来自 city filter 修复 + PDF 清洗，BM25 hybrid 只贡献了 +1.8pp MRR。

**追问：为什么不用 ChromaDB？**

~7,400 chunks 量级太小，内存完全够（O(n) 余弦搜索在 10K 级别 ~100ms）。少一个外部依赖，单 JSON 文件 11MB 部署简单。

---

## 7. LLM 调用策略

**Q: 模型分层怎么做的？**

```typescript
// 模型两档
planning → LLM_MODEL (大模型)
其他     → LLM_LIGHT_MODEL (小模型)

// Temperature 三档
gathering/searching → 0.4  // 稳定工具选择
selecting           → 0.1  // 结构化输出
planning            → 0.7  // 创意编排

// Max Tokens 两档
planning → 8192
其他     → 4096
```

**追问：为什么只 planning 用大模型？**

成本/延迟 vs 能力权衡。gathering/searching/selecting 是机械性任务，小模型胜任。planning 生成长篇结构化 JSON，对逻辑连贯性要求高，必须大模型。

**追问：Zod Schema 在哪些环节用？**

1. `finalize_plan` 输出经 `TravelPlanSchema.parse()` 严格校验
2. 所有核心类型由 Zod Schema 定义，TypeScript 类型从 Schema 推导
3. JSON 自修复失败时 Zod 校验信息回传 LLM 修正

---

## 8. 可观测性

**Q: 可观测性怎么做的？**

三层：

1. **结构化 Trace（JSONL）** — 7 种事件类型（llm_request/llm_response/tool_exec/state_change/phase_change/user_message/assistant_reply），每条带 sid+iter+timestamp，tool_exec 额外带 fallback_level+duration_ms
2. **trace-viewer 三栏 HTML** — 左栏 iter 列表（标注 phase），中栏当前轮详情（thought+tool_calls+耗时+fallback_level），右栏 state diff（本轮新增/修改字段）
3. **AsyncLocalStorage + sessionLogger** — 跨异步调用传递 sessionId，不污染函数签名

**追问：为什么不用 OpenTelemetry？**

数据量小（每 session 几十条 trace），单体服务不需要分布式追踪，JSONL 直接 `cat | grep | jq` 就能分析。

---

## 9. 餐厅两阶段搜索

**Q: 为什么分两阶段？**

用户原话："景点与景点之间衔接的餐饮也要安排"。

- **第一阶段（searching, 城市级）** — 搜"北京+美食"，存 `candidateRestaurants`，让 LLM 行程编排前有城市餐饮画像
- **第二阶段（planning, 景点级）** — 搜"故宫周边 lunch"，高德 POI 周边搜索（radius=1500m），存 `planningRestaurants`

**追问：过滤规则？**

1. 排除连锁（麦当劳/星巴克），除非用户显式要求
2. 本地特色 ≤ 60%，留 40% 给大众友好选择
3. 三源融合加权：高德 POI(0.85) + 小红书(0.70) + RAG 攻略(0.65)

---

## 10. 刁钻追问

**Q: SessionStore 的乐观锁？**

`ConversationContext` 带 `version`。每次 `set` 校验 `current.version === ctx.version - 1`，不匹配抛 `VersionConflictError`。防止并发 SSE 事件 + select 请求同一 session 的状态覆盖。

**追问：为什么不直接用锁？**

SSE 长连接加锁会导致所有事件串行化，延迟不可接受。乐观锁适合读多写少场景。

**Q: 为什么不用 LangChain？**

1. 抽象层太厚，出问题难定位
2. 工具调用链路不透明
3. 自己的 ToolRegistry + phase gating + fallback chain 更可控
4. 零额外依赖

**Q: 最大技术挑战？**

**让 LLM 输出可靠到能被下游代码消费。** JSON 总有格式错误、LLM 有时幻觉航班号/酒店名、ReAct 循环可能卡死。整个系统的可靠性本质是在和 LLM 的不确定性对抗。

**Q: 如果重做？**

1. 先纸面推演再选架构 — Agent Loop 花了很多时间但 10 个 case 就能判断不适合
2. Pipeline 可以更简洁 — enrichDestination 不需要独立步骤
3. RAG 语料质量比检索算法重要 — PDF 本身不够结构化是最大瓶颈

---

## 11. 快速问答

- **最大并发？** 受限于高德 QPS=3，约 2-3 并发 session
- **一次规划耗时？** Pipeline ~20s，Agent Loop ~40-60s
- **LLM 调用次数？** Pipeline 4-6 次，Agent Loop 8-15 次
- **测试覆盖？** Agent Loop runtime 216 条单元测试
- **代码规模？** src/ 下 60+ TypeScript 文件
- **部署？** `node dist/api/app.js`，单进程，无 Docker
- **已知缺陷？** Agent Loop searching 阶段 LLM 可能遗漏返程交通搜索

