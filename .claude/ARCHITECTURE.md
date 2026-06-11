# Multi-Agent Travel Planner 架构文档

## 系统概览

多 Agent 旅行规划系统。用户通过自然语言对话描述旅行需求，系统自动编排航班/酒店/景点/预算 Agent 协同工作，输出个性化行程方案。

## 核心业务链路

```
用户消息 → HTTP API → ConversationOrchestrator
  → StateMachine (INIT → GATHERING → SEARCHING → COMPLETED)
  → TurnHandler (意图路由 + 多轮信息收集)
  → TravelPlanningPipeline
    → PreferenceAgent → enrichDestination → refreshSelectedPrices
    → PipelineExecutor [FlightAgent + HotelAgent] (并行)
    → LLMPlanAgent (ReAct 循环，5 工具)
    → BudgetLoopController (预算循环，最多 N 轮)
  → SSE 流式响应
```

## 模块骨架

```
src/
├── agents/           # Agent 实现
│   ├── llm-plan-agent.ts   # ReAct 循环，tool_use 调用景点/餐厅/XHS/RAG 搜索
│   ├── flight-agent.ts     # 航班搜索 + 12306 火车票
│   ├── hotel-agent.ts      # 酒店搜索 + 距离排序
│   ├── budget-agent.ts     # 预算校验 + 约束调整
│   ├── preference-agent.ts # 偏好标准化
│   └── activity-agent.ts   # 降级备用（mock）
├── orchestrator/
│   ├── pipeline.ts              # 主编排器，串联所有 Agent
│   ├── parallel.ts              # PipelineExecutor：并行/顺序 + 超时重试 + 快照恢复
│   ├── budget-loop.ts           # 预算循环控制器
│   └── conversation-orchestrator.ts  # 对话层编排，状态机驱动
├── conversation/
│   ├── state-machine.ts    # 有限状态机 (7 状态)
│   ├── session-store.ts    # 会话存储（Memory / File 持久化）
│   ├── context.ts          # ConversationContext + PlanSummary 构建
│   ├── turn-handler.ts     # 单轮对话处理（意图路由 + 工具调用）
│   └── info-extractor.ts   # LLM 从用户消息提取结构化偏好
├── data-sources/
│   ├── amadeus-source.ts   # Amadeus 航班 API
│   ├── booking-source.ts   # Booking.com 酒店 API
│   ├── amap-source.ts      # 高德 POI + 路线规划 (QPS 限流)
│   ├── train12306-source.ts # 12306 火车票 (MCP JSON-RPC)
│   ├── web-search-source.ts # Web 搜索（baidu/sogou/bing + Firecrawl 兜底）
│   └── fallback-data-source.ts # 降级链包装
├── rag/
│   ├── rag-source.ts       # RAG 搜索入口（向量化 + 余弦相似度）
│   ├── corpus-loader.ts    # 语料加载 + Chunking（TravelDoc/TechDoc 策略）
│   ├── eval.ts             # 评估脚本（Hit Rate/MRR/NDCG@10/Precision@5）
│   └── types.ts            # RagDocument, ChunkStrategy, Section
├── intent-router/          # 意图分类 + RouteDecision
├── step-executor/          # 统一 AgentStep 生命周期
├── trace-recorder/         # 结构化 TraceEvent
├── tools/                  # 工具注册表 (8 工具)
├── types/                  # 核心类型定义
├── api/                    # Fastify HTTP 路由 + SSE
├── config/settings.ts      # 分层配置（LLM/Session/RAG/Cache）
└── public/chat.html        # 单文件前端（Tailwind + SSE）
```

## 关键数据流

### 会话持久化
- `MemorySessionStore`：Map 内存存储（默认）
- `FileSessionStore`：`data/sessions/{sid}.json`，原子写（.tmp + rename），60s TTL 扫描，乐观锁 version

### Agent 重试机制
- `PipelineExecutor.runSingle()` 在首次执行前 `structuredClone(state)` 快照
- 超时后 `restoreState()` 恢复快照，再以 1.5x 超时重试
- 仍失败则标记 `degraded`，继续下游 Agent

### LLMPlanAgent Checkpoint
- ReAct 循环状态（messages、tool 历史、搜索标志）存于 `state.llmPlanCheckpoint`
- 跨实例恢复：PipelineExecutor 重试创建新 LLMPlanAgent 时从 state 读取 checkpoint

### 价格漂移校验
- `refreshSelectedPrices()` 在 enrichDestination 之后、budgetLoop 之前执行
- 对用户已选航班/酒店重新查价，>10% 漂移生成 warning + 更新价格

### RAG 系统
- 嵌入：text-embedding-3-small → MemoryVectorStore（余弦相似度）
- Chunking：可插拔策略 — TravelDocStrategy（## 标题切分）/ TechDocStrategy（代码块+表格原子单元）
- 语料来源：JSONL 种子 + 百科缓存 + 小红书笔记
- 5 搜索工具：search_attractions / search_restaurants / search_xhs_notes / search_travel_guides / search_web

## 外部服务依赖

| 服务 | 用途 | 降级策略 |
|------|------|----------|
| OpenAI/Anthropic API | LLM 推理 | 无 |
| Amadeus | 航班搜索 | WebSearch 兜底 |
| Booking.com | 酒店搜索 | WebSearch 兜底 |
| 高德 | POI + 路线 | WebSearch 兜底，QPS≤3 |
| 12306 MCP | 火车票 | WebSearch 兜底 |
| 小红书 Python 服务 | 笔记搜索 | WebSearch 兜底 |
| Firecrawl | 搜索兜底 | 无 |

## 配置关键项

```
LLM_PROVIDER=anthropic|openai    LLM_BASE_URL / LLM_API_KEY
LLM_LIGHT_MODEL / LLM_PLAN_MODEL
LLM_TEMPERATURE_STRUCTURED / LLM_TEMPERATURE_PLAN
LLM_MAX_TOKENS_PLAN=16000        BUDGET_MAX_RETRIES=3
SESSION_STORE_TYPE=memory|file   SESSION_STORE_PATH=./data/sessions
RAG_ENABLED=true                 RAG_EMBEDDING_MODEL=text-embedding-3-small
FIRECRAWL_ENABLED=true           FIRECRAWL_API_KEY
```
