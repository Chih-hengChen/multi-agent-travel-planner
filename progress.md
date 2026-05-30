# Progress

## 已完成

### 真实数据源 + 用户偏好 + 前端向导 (2026-05-30)

- **Phase 1** `054d9ca`: 真实数据源接入 — Amadeus (航班), Booking.com/RapidAPI (酒店), 高德地图 (景点), 火车票价参考表。删除全部 Mock 数据生成（prng.ts, seed.ts）
- **Phase 2** `4e7cff8`: 用户偏好扩展 — transportPreference, departureTime, budgetStrictness, specialRequests。FlightAgent 支持火车优先，BudgetAgent 支持灵活预算
- **Phase 3** `3c6b125`: 前端偏好采集向导 — 5步可折叠面板（基础信息→交通→兴趣→预算态度→特殊需求），芯片选择+预算滑块

### 之前的提交

- `df4eecb`: tool_use + SSE 流式对话重构
- `d68a7e5`: 确定性 Mock + 条件重搜 + Activity 模型重构

## 下一步待办

- 配置真实 API Key 后端到端测试（Amadeus/高德/RapidAPI）
- 验证未配置 Key 时的优雅降级
- DestinationAgent 当前仍使用硬编码目的地列表，应接入 LLM 动态推荐
