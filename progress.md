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

## 下一步待办

- Phase 3: 行程编辑交互（拖拽、替换、备注）
- 端到端测试：配置真实 API Key 验证完整流程
- HotelAgent 无 fallback 后需验证 Booking.com API 可用性
