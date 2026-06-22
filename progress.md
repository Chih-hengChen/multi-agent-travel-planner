# Progress

## 已完成

### P2 Agent Loop 可观测性 + 数据飞轮 (2026-06-22)
- `9557b4e` docs: P2-A/B/C contracts 文档（~1500 行）
- `c021526` feat(p2-a): trace-viewer 三栏 HTML 渲染器 + 4 mock fixtures + 26 测试
- `5276a53` feat(p2-b): 反馈 API（/api/feedback）+ chat.html 1-5 星评分 UI + LLM 自评 + review-feedback CLI
- `b460f4b` fix(runtime): LLM 响应格式兼容（extractText）+ Agent Loop 死循环检测（MAX_STALE_ITERS=5）+ transportPreference 字段映射
- 旧 Pipeline 修复可用（thinking disabled, 真实 API），Agent Loop 仍因 stub tools 无法走通全流程

### RAG 第四轮实验:数据 bug 揭露 + 全量重测 (2026-06-21)
完整记录在 `docs/rag-optimization-log.md` §10(追加章节,不改 §1-§9)。起因:用户质疑"成都攻略有数据却搜不出来",实地调查 store 后揭露 3 个被前三轮忽略的 bug:
- **Bug A (阻断性)**:eval city="成都" vs store city="成都攻略",严格 `!==` 过滤 → 成都 20 条 query 全 0 命中。store 124 个 city 中 30+ 个带后缀("浙江攻略"/"香格里拉9日"...)。
- **Bug B (掩盖性)**:`rag-eval.ts:130` `failedQueries` 用过滤后数组索引取原数组,失败 ID 永远只落在 queries[0..35],成都/西安/广州失败不出现 → 失败分布报告长期失真。
- **Bug C (质量损耗)**:PDF 噪声——`-- N of M --` 分页符、`[city][cat] title - ` 重复前缀、表格残留。
- **修复**:(1) `failedQueries` 改 flatMap;(2) `vector-store.ts` + `rag-source.ts` city filter 改 `=== || startsWith`;(3) 新建 `scripts/rag-clean-store.ts` 一次性清洗 store(9432 → 7312,丢 2120 条纯噪声),原始备份到 `travel_guides.raw.json`。
- **重测**:V0 baseline 61% → **86%(+25pp)**,V3 67% → **86%(+19pp)**。**契约目标 Hit@5 ≥ 85% 达成**。
- **关键发现**:前三轮"瓶颈在 embedding 召回"归因部分错误 — 真实瓶颈是数据 bug。修了 city filter 后 V0 向量+BM25 fallback 直接到 86%,embedding 本身工作正常。
- **V3 vs V0**:Hit@5 持平 86%,但 V3 的 MRR +1.8pp / NDCG +3.8pp(p<0.0001)显著更优。**默认 variant 改为 v3**。
- **V5/V6(LLM 扩展路径)正式废弃**:修复后显著变差(-2~-3pp p<0.001)+ 延迟 26-32 倍。
- **下一步候选**:扩主题语料 / 真实 ground truth 标注 / cross-encoder reranker(目标 ≥90%)。

### RAG 第三轮实验:V6 LLM 扩展 × BM25 (2026-06-20)
完整记录在 `docs/rag-optimization-log.md` §9,核心发现:
- **实装 V6 variant**(LLM 扩展 × BM25):原 query + 3 个 LLM 扩展的 tokens 并集 → 单次 BM25(共享 IDF)。`RagVariant` 类型扩展为 v0-v6,`rag-eval.ts` 白名单同步加 v6。
- **第一版 V6 踩坑**:每个 expansion 独立跑 BM25 再 max 合并,导致 IDF 不可比、Hit@5 仅 63%。
- **修复版 V6**:tokens 并集 + 单次 BM25,Hit@5=66%、MRR=0.577、avg 2420ms,但仍**未超过 V3(67%/0.616/43ms)**。
- **LLM 扩展路径被证伪**:V5(LLM+向量)和 V6(LLM+BM25)都只到 66%,均不超过 V3。LLM 扩展的 IDF 稀释 + 向量增益丢失抵消了关键词覆盖增益。
- **关键学习**:BM25 分数跨 query 不可比 — 多变体合并必须共享 IDF(对后续 RRF 实验有参考价值)。
- **当前最优保持 V3**(BM25 hybrid + 向量 fallback),下一步候选:扩原始语料 / 提阈值 / RRF / 换 embedding / cross-encoder reranker。

### RAG 第二轮实验:LLM 扩展 + Embedding 修复 (2026-06-19)
全天完整实验记录在 `docs/rag-optimization-log.md` §8,核心发现:
- **Embedding 一直没工作**:embedder 静默返回空向量,此前全部结果(67% Hit)是纯 BM25 关键词匹配跑出来的。根因是 RAG_EMBEDDING_* 未配置,fallback 到不支持的 Anthropic 端点。
- **修复 embedding 后**:embedding-3(2048 维),向量搜索 V0=61%,反而比纯 BM25(67%)差。阈值 0.3 太宽松引入噪音。
- **V5 从硬编码词典重建为 LLM 扩展**:streamChat 调用 glm-5.1,例句"故宫怎么玩"→"紫禁城游览攻略",救回 3 条 query(36→33 vs V0 向量版),但仍未超越纯 BM25。
- **阶段结论**:BM25 是当前最强单一引擎;V5 LLM 扩展有价值但被向量拖后腿;下一步 = V5 LLM 扩展×BM25(不依赖向量)。
- 修复:NDCG per-query 化 / 失败分析 city 过滤 / keywordFallback 升级 BM25 / embedder 错误日志 / .env 加 RAG_EMBEDDING_* 配置

### P1-B RAG 复盘 + 修复 (2026-06-19)
对前轮 V0/V3/V4/V5 实验做诚实复盘,发现 5 个评测/算法缺陷,按 ROI 顺序修复并重测,完整记录在 `docs/rag-optimization-log.md` §6/§7:
- 修 `scripts/rag-eval.ts` NDCG@10:从「整个 dataset 二元 hit 数组」改为 per-query 计算(V0 NDCG 从异常的 1.0000 → 合理的 0.3775)
- 新增 `scripts/rag-analyze-failures.ts`:扫描 store 区分「语料缺失 vs 召回不足」(30 条失败 = 1 缺失 + 29 召回不足)
- 新增 `scripts/rechunk.ts`:V1/V2 chunk size 实验语料重切(按 source/city/title 聚合)
- 修 `src/rag/rag-source.ts`:V5 召回扩展(原 query + 扩展词召回并集)/ V3 min-max 尺度对齐 / fallback 短路(只 V0 走 fallback,V3/V5 即使低分也进分支)/ RagVariant 扩展为 v0-v5 / 加 corpusDir 参数避免污染 V0 cache
- 修 `src/rag/corpus-loader.ts`:`loadSeedDirectory(dataDir)` 改为直接目录而非 cwd
- 重测 6 variant:V1/V2 显著变差(-29pp,因现有 micro-chunks 粒度太小);V3/V4/V5 修复后仍与 V0 完全相同——真实负面信号,瓶颈是 embedding 召回阶段
- 阶段结论:默认保持 v0;下一步方向 = 降 SIMILARITY_THRESHOLD / 加 cross-encoder reranker / 换 embedding 模型

### P1-B RAG variant 实验 (2026-06-19)
基于契约 §1 跑 V0/V3/V4/V5 4 个 variant 实验,完整记录在 `docs/rag-optimization-log.md`:
- `98187eb` feat(rag): V0/V3/V4/V5 variant experiments + per-query bootstrap
- RagSource 新增 `variant` 参数(默认 v0 向后兼容),实装 V3 Hybrid BM25 / V4 MMR / V5 Query Expansion
- rag-eval.ts 输出 perQueryHits/perQueryRanks(供 bootstrap);rag-compare.ts 修 ESM require bug + 用 perQuery 数组做 CI
- 4 个 variant 在 100 条 eval set 上 hit@5 均=66%、MRR=0.5950,**无统计显著差异**(delta=0, p=1.0)
- 失败 30/100 query 多因语料缺失,V3/V4/V5 重排救不回
- V1/V2/V6 需重新生成语料 chunk,留待续作
- 结论:默认 variant 保持 v0;距离 Hit@5≥85% 目标差 19pp,需语料扩容 + 真实标注 + chunk size 实验

### P0-C §3 Pipeline 删除 (2026-06-19)
按契约 §3 完成废弃 Pipeline 和 deprecated Agents 清理:
- 删除:`orchestrator/pipeline.ts` / `budget-loop.ts` / `parallel.ts`
- 删除:`agents/{activity,budget,destination,preference}-agent.ts`(4 个)
- 保留:`agents/base-agent.ts`(被 FlightAgent/HotelAgent/LLMPlanAgent 继承)、`gathering-agent.ts`(turn-handler generateQuestion 仍在用,待 Agent Loop 完整接管 gathering phase 后删)
- 改 `plan-travel.ts` 为 deprecated 桩(execute 返回 410-like 错误,不再调 Pipeline)
- 改 `turn-handler.ts`:移除 `pipeline` 字段 + import;`runPipeline` 改为返回 deprecated 错误,提示用 Agent Loop
- 改 `routes.ts`:`/api/plan` 和 `/api/plan/full` 改为 410 Gone;`TurnHandler` 构造不再传 Pipeline
- 改 `cli/index.ts`:打印 deprecated 提示并 exit 1
- 更新 barrels:`agents/index.ts` 只 re-export BaseAgent/FlightAgent/HotelAgent/LLMPlanAgent;`orchestrator/index.ts` 只 re-export ConversationOrchestrator
- 修 `llm-plan-agent.ts:169` cast(顺手修一个 unknown 类型错误)
- 71/71 测试通过;剩余 TS 错误均为既有问题(trace.test.ts / e2e.test.ts / agent-loop TraceEvent schema / sse.ts / turn-handler handleViaAgentLoop adapter)

### Agent Loop Review 修复 (2026-06-19)
基于契约对齐 review 修复 7 项关键问题(P0-C §3 删除废弃 Pipeline 留作续作):
- P0:`policy.ts` 加 `search_flights / search_trains` 到 searching phase,`apply-tool-effects.ts` 加 effect handler 把 `data.flights + data.trains` 合并到 `candidateTransports`,解决 searching→selecting→planning 转换链断
- P0:`apply-tool-effects.ts` 重写 `select_transport / select_hotel` reducer,从 `candidateTransports / candidateHotels` 按 id find 完整对象;`ToolResultLike` 加可选 `_jsonRepairError?: boolean`;`finalize-plan.ts` 失败分支设置该标记,使 `agent-loop.ts:302` self-repair loop 真正触发
- P1:`search-xhs.ts` 修复 `rerankXhs` 的 a/b 颠倒 bug(原实际为低赞升序)
- P1:`search-restaurants.ts` 实现 `scoreRestaurant + isLocalSpecialty + 本地特色 60% cap`,接入 `callAmap` QPS 限流,输出 `scores` 字段供 rerankScores 提取
- P1:`search-hotels.ts` 实现 `geoConstraint` 完整路径(`HotelSearchInputSchema` Zod 校验 + `preferredArea / keyAttractions / preferredBrands` 过滤 + `preferNear=center/transit` 排序)
- P1-C:`finalize-plan.ts` 加 `validatePlanQuality` 硬约束(transit coverage / 连锁品牌 / 本地特色 60% cap),失败设置 `_jsonRepairError` 触发 LLM self-repair
- P1-B:新增 `scripts/gen-eval-set.ts`,生成 `data/rag/eval-v1.jsonl`(100 条,5 城市 × 5 类别 × 4)
- 测试:更新 `policy.test.ts / apply-tool-effects.test.ts` 匹配新契约(12→14 工具,select 用例改 id-based lookup),71 测试通过

### P1-A + P1-B + P1-C 实现 (2026-06-18)
- `485c7b7` feat(scripts): P1-B RAG evaluation scripts (rag-eval/rag-compare/label-tool)
- `f441eb5` feat(runtime): P1-C itinerary quality enforcement (timeline transit + diversity + self-check)
- `f1a9582` feat(runtime): P1-A jsonrepair + LLM self-repair loop (parsePlanLoose three-layer + maxRetries=3)
- P1-A: 3-layer JSON defense (extract → jsonrepair → simpleRepair) + LLM self-repair loop in agent-loop
- P1-B: RAG eval scripts for 6-variant experiment; eval set expansion framework (label-tool + rag-eval + rag-compare)
- P1-C: Planning phase prompt enhancement (timeline transitToNext coverage, restaurant diversity, Activity.source, 8-item self-check checklist)

### P0-C Agent Loop 接入对话流 (2026-06-18)
- `7c84e52` feat(conversation): USE_AGENT_LOOP feature flag + integration
- `800132f` refactor(conversation): add Agent Loop integration route to TurnHandler
- `41c19f7` feat(runtime): SSE event bridge for Agent Loop
- `f214e86` feat(context): add AgentState to ConversationContext
- ConversationContext `agentState` 字段添加
- SSE 事件桥接(llm_request/llm_response/tools_executed → progress)
- TurnHandler.handleViaAgentLoop() — LLMCaller+ToolExecutor 适配,Agent Loop 委托
- USE_AGENT_LOOP 特性开关 (env flag, 默认关闭)

### P0-B 实现 + P0-C/P1-A/P1-B/P1-C 契约文档 (2026-06-18)
- P0-B 实现(7 commits): schemas 抽取 → 6 新工具 → hotel geoConstraint + xhs 渐进抓取 → select 工具 → LLMPlanAgent 迁移 → 死代码清理
- `docs/p0-c-contracts.md`: P0-C Loop 接入对话流(SSE 事件映射 + 删除旧 Pipeline + 5 步 plan)
- `docs/p1-a-contracts.md`: P1-A JSON 鲁棒(jsonrepair + 三层防御 + LLM 自修复 maxRetries=3)
- `docs/p1-b-contracts.md`: P1-B RAG 优化(交付物 + 指标目标 + 实验流程,索引 rag-optimization-plan.md)
- `docs/p1-c-contracts.md`: P1-C 行程质量(时间线交通 + 餐厅多样性 + 信息源融合)
- `docs/p0-b-contracts.md`: P0-B 工具系统重做接口契约

### P0-A Step 7: plan_transit + finalize_plan 工具 (2026-06-18)
- `18ec7cb` feat(tools): plan_transit + finalize_plan with JSON schema
  - 新增 `plan-schema.ts`: 完整 Zod 行程 JSON schema + `parsePlanLoose` 三层防御（brace-balanced 提取 + JSON.parse + simpleRepair）
  - 新增 `plan-transit.ts`: 市内交通规划 —— state 已有坐标优先 → 高德地理编码 → 高德路径规划 → Haversine 估算降级
  - 新增 `finalize-plan.ts`: 行程交付 —— parsePlanLoose + `computeBudgetBreakdown` 预算分类汇总
  - 新增 `plan-schema.test.ts`: Zod 校验 + parsePlanLoose 修复覆盖率 100% (18/18)

### P0-A Step 8: phase-specific system prompt builder (2026-06-18)
- `84da275` feat(runtime): phase-specific system prompt builder
  - 抽取 `BASE_PROMPT` / `PHASE_PROMPTS` / `buildSystemPrompt` / `stateSummary` 到独立 `system-prompt.ts`
  - 新增 `system-prompt.test.ts`: 5 个 phase 的 prompt 断言测试 + stateSummary 字段覆盖
  - agent-loop.ts 通过 re-export 保持向后兼容

### P0-A Step 9: barrel index.ts + e2e 集成测试 (2026-06-18)
- `dba35e7` feat(runtime): barrel index.ts + e2e integration test
  - 新增 `runtime/index.ts` barrel export，聚合 6 个模块的公开 API
  - 新增 `e2e.test.ts`: searching → selecting → planning → completed 全流程集成测试
  - E2E 覆盖：多 phase 转换、并行 tool_use、thought 解析、budget 回退循环、immutable state

### Agent Loop 架构重写 (2026-05-31)

- `ba81715` feat: LLM agent loop — collect_preferences 工具 + SSE 事件流 + 前端 Agent Loop 交互。LLM 识别旅行意图后调用 collect_preferences 触发前端弹窗，用户填写偏好后以 tool_result 回传继续对话。删除所有硬编码假数据（Mock 目的地、模板餐厅、fallback 酒店、train-data.ts）
- `c06b845` feat: 真实数据源集成 — 12306 MCP 火车票查询（JSON-RPC over stdio）、高德 POI 餐厅搜索、ActivityAgent 用真实餐厅 POI。所有 DataSource 实现 searchRestaurants 接口

### 真实数据源 + 用户偏好 + 前端向导 (2026-05-30)

- `054d9ca`: Amadeus 航班 + Booking.com 酒店 + 高德景点 + 火车票价参考
- `4e7cff8`: 偏好扩展（交通/出发时间/预算态度/特殊需求）
- `3c6b125`: 前端偏好采集向导

### Phase 1: 对话状态机 + 信息收集 (2026-06-02)

- `719a5f7` feat: 多轮对话状态机（INIT → GATHERING → SEARCHING → COMPLETED）+ Session 管理 + 前端重构
- 新增 7 个模块：state-machine, context, session-store, info-extractor, gathering-agent, turn-handler, conversation-orchestrator
- 前端移除 wizard modal，改为自然语言多轮对话 + 状态进度指示器
- 保留旧 API（/api/chat/stream, /api/plan）不受影响

### Phase 2: 交通/酒店选择卡片 + SourceResolver (2026-06-04)

- `b755a46` feat: 交通/酒店交互式选择卡片 + SourceResolver 数据源降级链
- 状态机扩展：SEARCHING_TRANSPORT → SELECTING_TRANSPORT → SEARCHING_HOTELS → SELECTING_HOTEL → SEARCHING
- SourceResolver：per-source 超时 + fallback 链（Amadeus/Booking/Amap → WebSearch）
- POST /api/chat/:sid/select 处理交通/酒店选择
- 前端选择卡片：radio 交通选项 + 酒店卡片，支持重新搜索和回退
- 信息收集完毕自动触发交通搜索 → 用户选择 → 酒店搜索 → 用户选择 → 行程规划

### WebSearch 真实搜索集成 + 城市知识缓存 (2026-06-05)

- `843d8da` fix: add baidu engine for better Chinese train results（sogou 反爬封禁，bing 返回无关百科）
- `45dee37` fix: multi-query train search with relevance check and LLM fallback
- `14606c1` feat: cache city tourism knowledge from baike for LLM attraction extraction
- 搜索引擎优先级：baidu > sogou > bing
- 城市百科知识缓存（24h TTL），景点/餐厅搜索自动附加百科旅游上下文
- 多轮查询 + 相关性检测 + LLM 兜底：列车搜索尝试 3 种 query，不相关时用 LLM 知识生成

### Phase 3: 行程编辑交互 (2026-06-05)

- `3980c04` feat: PUT /api/chat/:sid/plan endpoint for plan editing persistence
- `32002c8` feat: plan card editing mode with drag/drop, notes, and delete
- 后端：ConversationContext.editedPlanSummary + handleEditPlan() + PUT route
- 前端：编辑模式下活动可拖拽（跨天）、可删除、可添加备注，保存后持久化到 session

### 工具注册表 + 小红书搜索集成 (2026-06-05)

- `68cfe23` feat: 统一工具注册模块 + 小红书搜索 + 8 个注册工具
- 新增 `src/tools/` 模块：ToolRegistry、RegisteredTool、ToolResult、ToolSource 类型体系
- 8 个工具注册到 registry：collect_preferences, plan_travel, search_xhs_notes, search_web, search_trains, search_flights, search_hotels, search_attractions
- LLM 通过 Anthropic tool_use 协议自主选择调用工具
- XHS 搜索工具支持 fallback：Python 服务不可用时降级到 web search
- 新增 `xhs-service/` Python FastAPI 微服务（封装 Spider_XHS）
- stream-handler.ts 重构为 registry 驱动，通用化 requiresUserInput 处理
- SourceResolver 新增 resolveAttractions() 公开方法

### XHS 服务修复 + 端到端验证 (2026-06-05)

- `2d8977c` fix: add missing loguru dependency — ImportError 被误报为 "Spider_XHS not found"
- `b88fc94` fix: 补全 4 个缺失 JS 文件 + npm 依赖 + os.chdir 修复 require 路径
- `d1a6c0b` fix: curl_cffi TLS 指纹伪装绕过 XHS 反爬，搜索功能端到端验证通过

### 用户选择注入 Pipeline (2026-06-05)

- `8e45a7e` feat: inject user-selected transport and hotel into pipeline
- context.ts: TransportOption → Train/Flight 转换 + selectedHotel 查找
- flight-agent.ts: 检测 selectedOutbound/selectedReturn 时跳过搜索，直接使用用户选择
- hotel-agent.ts: 检测 selectedHotel 时跳过搜索，直接设置推荐酒店并计算总价

### 系统性调试验证修复 6 项核心 Bug (2026-06-05)

- `4967087` feat: split transport preference into outbound/return — 去程返程独立搜索
- `8e45a7e` feat: inject user-selected transport and hotel into pipeline — 用户选择不再被覆盖
- `4da82fc` feat: mustVisitAttractions priority + smart transit + city food map — 景点优先级+智能交通+城市美食
- `9576649` feat: hotel Chinese names via Amap POI + session logging — 酒店中文名+日志追踪

### LLM 作为 Brain — 替换算法式 ActivityAgent (2026-06-05)

- `72d5d91` feat: LLMPlanAgent — LLM 通过 tool_use 循环生成行程
- 核心：LLM 调用 search_attractions/search_restaurants/search_xhs_notes 获取信息，智能编排行程
- 修复：info-extract 拆分去程/返程偏好提取 + turn-handler 独立搜索 + enrichChineseNames 品牌匹配 + diningPreference 默认 local_specialties
- Pipeline 中 ActivityAgent → LLMPlanAgent

### Firecrawl 搜索兜底 (2026-06-05)

- `86b7132` feat: Firecrawl API 作为 web search daemon 不可用时的自动兜底
- daemon 失败/空时自动调用 Firecrawl `/v2/search`（搜索+markdown 一步返回）
- 配置：`FIRECRAWL_API_KEY` 环境变量，`FIRECRAWL_ENABLED` 开关
- 无新依赖，改动集中在 `WebSearchSource` 内部

### Pipeline 超时重试+恢复+降级回路 (2026-06-07)

- `df7ad2a` fix: add retry, recovery and degradation to pipeline execution
  - ParallelExecutor 改为 per-agent 顺序执行 + 独立超时（默认 120s）
  - 超时后自动重试一次（1.5x 超时），仍失败则降级（degraded）
  - BudgetLoopController 检测 AgentRunResult，记录 recovery_action 事件
  - Pipeline 中 LLMPlanAgent 降级时自动回退到 mock ActivityAgent
  - 新增日志事件：agent_retry / agent_degraded / recovery_action / pipeline_fallback

### 面试暴露问题系统性修复 (2026-06-10)

- `97650b3` feat: FileSessionStore — 文件持久化会话存储，原子写+TTL 扫描+乐观锁
- `cbe4139` feat: Agent 重试状态隔离（structuredClone 快照恢复）+ Checkpoint 迁移到 state 级 + 价格漂移校验（10% 阈值）
- `f99459d` feat: RAG 评估增强（50 条 query + NDCG@10 + Precision@5 + 按类别统计）+ 可插拔 Chunking 策略（TravelDocStrategy/TechDocStrategy）

## 下一步待办

- 端到端测试：启动服务验证去程高铁返程飞机场景
- 端到端测试：验证用户选择交通/酒店后 pipeline 正确使用选择项
- RAG eval 跑一次基线，确认新指标落在合理区间

### Phase 1~5 演进架构实现 (2026-06-07)

- `574f22f` feat: implement phases 1-5 of Agent Runtime evolution spec
  - 新增 IntentRouter 模块（意图分类 + RouteDecision）
  - 升级 State Machine（ERROR_RECOVERABLE/ERROR_TERMINAL + StateSpec）
  - 新增 StepExecutor（统一 AgentStep 生命周期）
  - 新增 Tool Policy + ResultValidator（风险等级 + 输出校验）
  - 新增 TraceRecorder（结构化 TraceEvent，8 种 actor）
  - 新增 ConversationSummary（三层上下文 + 自动摘要）
  - IntentRouter 集成到 TurnHandler

## 后续待办

- 提交上述演进架构代码变更
- 编译验证变更无 TypeScript 错误
- 将 StepExecutor 集成到 TurnHandler 的搜索/规划步骤中
- 将 TraceRecorder 集成到 ConversationOrchestrator 的状态迁移中
- 为 IntentRouter 增加单元测试

### 酒店位置智能排序 + LLM Prompt 增强 (2026-06-07)

- `b348009` fix: hotel location awareness and enhanced LLM system prompt
  - BookingSource 计算 Haversine 距离，按距市中心距离+价格排序
  - 前端酒店卡片显示"距市中心Xkm"
  - LLMPlanAgent system prompt 重写为结构化多段提示（景点覆盖、酒店合理性、日程节奏、餐饮限制）

### RAG 旅行攻略服务 (2026-06-07)

- `586f95b` feat: add RAG travel guides service with search_travel_guides tool
  - 新增 src/rag/ 模块：types/Embedder/MemoryVectorStore/corpus-loader/RagSource
  - LLMPlanAgent 第5个 ReAct 工具：search_travel_guides
  - 种子语料：14条攻略覆盖北京/成都/广州/西安
  - 配置：RAG_ENABLED / RAG_EMBEDDING_MODEL

### Plan UI 富行程展示 + LLMPlanAgent 可观测日志 (2026-06-07)

- `d5c739f` feat: enhance plan UI to test-suite format and add LLMPlanAgent trace logging
  - renderPlanCard 重写为富行程样式：标题/日期/总花费/交通/酒店/逐日行程
  - PlanSummary 新增 departureCity/hotelAlternatives 等字段
  - LLMPlanAgent.callLlmWithTools 新增完整 llm_request/llm_response 日志

### 行程时间线 + 参考资料重构 (2026-06-08)

- `uncommitted` feat: 每日行程改为时间线样式，市内交通内联展示
  - 前端：renderDayActivity → renderTimelineStop/renderTimelineTransit 时间线组件
  - 前端：行程卡使用时间线布局（蓝点+竖线），非交通活动显示图标/名称/时段/价格，交通活动显示连接箭头/方式/耗时/费用
  - 前端：数据源参考改为参考资料，移除重复的每日行程，新增参考来源区域
  - 后端：PlanSummary 新增 PlanReference 类型 + references 字段，plan-travel 自动聚合酒店/航班/高铁参考信息

### 架构改进：并行执行 + 预算真实化 + 入口统一 (2026-06-08)

- `uncommitted` feat: PipelineExecutor 真正并行执行 FlightAgent+HotelAgent（Promise.allSettled），延迟降低 40-50%
- `uncommitted` feat: BudgetAgent 约束真实化 —— searchConstraints 传递到数据源重新搜索
- `uncommitted` refactor: 移除旧入口 POST /api/chat/stream，统一为会话式 API
- `uncommitted` refactor: DestinationAgent 降级为纯函数 enrichDestination()
- `uncommitted` perf: VectorStore 启动预热
- `uncommitted` config: 分层 Temperature + LLM_MAX_TOKENS_PLAN + SESSION_STORE_TYPE
- `uncommitted` fix: FlightAgent.searchTrains 传递 maxPrice 预算约束

### 进度感知规划系统 (2026-06-08)

- `uncommitted` feat: Pipeline 执行期间通过 SSE 流式输出 progress 事件（阶段名、进度%、ETA）
- `uncommitted` feat: 权重式进度计算（Flight=20, Hotel=20, LLMPlan=40, Budget=5），动态 ETA 推算
- `uncommitted` feat: 前端聊天气泡内联进度条（阶段文字 + 进度条 + 剩余秒数），实时更新
- `uncommitted` feat: 预算循环多轮迭代进度正确报告轮次信息
- `uncommitted` types: 新增 ProgressUpdate 接口和 ProgressCallback 类型
- 改动：types/index.ts, parallel.ts, budget-loop.ts, pipeline.ts, turn-handler.ts, conversation-orchestrator.ts, chat.html

### ReAct 式选择状态恢复 (2026-06-08)

- `uncommitted` feat: SELECTING 状态死循环修复 —— LLM tool-call 自主恢复
  - 替换硬编码回复为 LLM（LLM_LIGHT_MODEL + STRUCTURED temperature）自主决策
  - 定义 select_option/rescan/skip_selection 工具，LLM 自主调用
  - 搜索结果为空时 LLM 自动解释并建议下一步
  - 兼容 OpenAI function_call 和 Anthropic tool_use 双格式
  - 单文件改动：turn-handler.ts (+159/-6)

### LLM 工具调用强制 + 行程质量修复 (2026-06-09)

- `e460ceb` fix: 强制 LLMPlanAgent 调工具收集信息，修复饮食推荐单一和缺少地铁细节问题
  - MIN_TOOL_CALLS=4 强制阈值：LLM 至少调用 4 次工具才能生成行程
  - prompt 强化 transit.description 必须注明线路号、站点、出入口
  - prompt 要求必须调用 search_restaurants + search_xhs_notes 获取真实数据
  - 新增搜索结果 rerank 机制（兴趣匹配 + 评分 + 名称特异性）
  - 自检清单增加餐饮多样性、出行细节检查

### 架构审计 + Bug 修复 + 文档同步 (2026-06-16)

- `35490ff` fix: TravelPlanningPipeline.dataSource 未绑定到 this —— refreshSelectedPrices 运行时崩溃修复（局部 const 改为类字段）
- `ee264fe` docs: src/ARCHITECTURE.md 同步实际状态
  - 标注 ToolRegistry（tools/* + api/tools.ts 共 12 文件）当前为死代码，未被任何活路径调用
  - 补 LLMPlanAgent 强制工具调用 + ReAct checkpoint 跨实例恢复
  - 补 PipelineExecutor structuredClone 快照 + restoreState 重试语义
  - 新增"价格漂移校验"小节（refreshSelectedPrices 10% 阈值）
  - 新增"会话持久化"小节（Memory/File + 乐观锁 + 原子写）
- 死代码处理方案待用户决策（选 C 暂时保留现状）
