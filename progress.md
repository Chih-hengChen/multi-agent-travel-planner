# Progress

## 已完成

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
