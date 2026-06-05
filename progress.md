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
- 6 项修复：①去程返程拆分 ②用户选择注入 pipeline ③景点必须包含 ④智能市内交通 ⑤酒店中文名 ⑥餐厅地域特色

## 下一步待办

- 端到端测试：启动服务验证去程高铁返程飞机场景
- 端到端测试：验证用户选择交通/酒店后 pipeline 正确使用选择项
- 端到端测试：验证景点包含用户指定的故宫/颐和园等
- 端到端测试：验证餐厅推荐为当地特色（北京→烤鸭/涮肉，成都→火锅/川菜）
- 端到端测试：验证市内交通有起终点描述，短距离步行
- 验证 session 日志：确认 logs/{sessionId}.jsonl 包含完整对话链路和 LLM prompt/response
