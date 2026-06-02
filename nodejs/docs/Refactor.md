# Multi-Agent Travel Planner — 重构架构文档

## 重构动机

### 原架构的问题

| 问题 | 原架构 | 重构后 |
|------|--------|--------|
| 交互模式 | 单次输入→单次输出 | 多轮对话，逐步收集信息 |
| 数据质量 | Mock 随机生成 | web_search 搜索真实数据 |
| 用户控制 | 系统自动选最优 | 关键节点展示选项卡，用户决策 |
| 输出粒度 | 粗粒度费用汇总 | 班次号、真实路线、餐厅菜品推荐 |
| 城市内交通 | 无 | 每段移动给出地铁/打车/步行多方案 |

### 新架构设计目标

```
输入：我想去北京旅游

轮次1：询问出发城市、日期、人数
轮次2：询问预算、住宿偏好、游玩偏好
轮次3：展示交通选项卡 → 用户选择
轮次4：展示酒店选项卡 → 用户确认
轮次5：流式输出精细化逐日行程

最终输出（节选）：
  武汉出发北京旅行计划
  6.1 出发日
  武汉站 → 北京西，G316，10:33-14:36，4小时3分，623元
  北京西 → 格林豪泰北新桥：推荐地铁7号线转5号线(5元/50分)，备选打车(52元/45分)
  下午4点后：南锣鼓巷→鼓楼→什刹海步行路线
  晚餐：鸭儿李记涮肉，推荐羊肉+麻酱饼，人均106元
```

---

## 对话状态机（核心设计）

### 状态转移图

```
INIT
  │ 提取目的地（destination）
  ▼
GATHERING_BASICS              ← 问：出发城市 / 日期 / 人数（最多一次问完）
  │
  ▼
GATHERING_PREFERENCES         ← 问：预算 / 住宿偏好 / 游玩偏好 / 饮食偏好
  │
  ▼
SEARCHING_TRANSPORT           ← 并行：search_trains + search_flights
  │
  ▼
SELECTING_TRANSPORT           ← SSE 推送 transport_options 卡片，等待用户选择
  │ (用户通过 /select 接口发送选择)
  ▼
SEARCHING_HOTELS              ← 基于 到达站 + 景点偏好 搜索区域酒店
  │
  ▼
SELECTING_HOTEL               ← SSE 推送 hotel_options 卡片，等待用户确认
  │
  ▼
PLANNING_ITINERARY            ← 并行：景点搜索 + 餐厅搜索 + 城市内路线规划
  │
  ▼
FINAL_OUTPUT                  ← SSE 流式输出完整逐日行程
```

### 错误处理与回退

```
任何 SEARCHING_* / PLANNING_* 状态
  │ 搜索失败 / 超时 / 解析异常
  ▼
ERROR                         ← SSE 推送 error 事件 + 友好提示
  │
  ├── 自动重试（retryCount < 2）→ 回到出错前的 SEARCHING_* 状态
  └── 重试耗尽 → SSE 推送降级方案（如 "未找到高铁，已为您搜索航班"）→ 继续流程
```

**回退路径**（用户主动操作）：

| 当前状态 | 回退目标 | 触发方式 |
|---------|---------|---------|
| SELECTING_TRANSPORT | SEARCHING_TRANSPORT | `/select` 请求带 `action: "rescan"` |
| SELECTING_HOTEL | SELECTING_TRANSPORT | `/select` 请求带 `action: "change_transport"` |
| SELECTING_HOTEL | SEARCHING_HOTELS | `/select` 请求带 `action: "rescan"` |
| PLANNING_ITINERARY | SELECTING_HOTEL | `/select` 请求带 `action: "change_hotel"` |

### 超时与并发控制

| 场景 | 超时时间 | 处理策略 |
|------|---------|---------|
| SELECTING_* 等待用户选择 | 30 分钟 | session 标记 `expired`，下次消息自动恢复到该状态 |
| 单次数据源搜索 | `SEARCH_TIMEOUT_MS`（默认 10s） | 超时后尝试 fallback 数据源或降级为空结果 |
| PLANNING_ITINERARY 全流程 | 60s | 超时后推送已完成的部分行程 + 超时提示 |
| 同一 session 并发请求 | - | 乐观锁（`ctx.version`），并发写入时拒绝后者并返回 `409 Conflict` |

**状态持久化**：每轮用户消息到来时，从 SessionStore 恢复 ConversationContext，处理完毕后写回。写入采用乐观锁：`ctx.version++`，`set()` 时检查 version 一致性。

---

## 目录结构

```
src/
├── conversation/                       # 对话层（全部新增）
│   ├── state-machine.ts                # 状态枚举 + 状态转移规则
│   ├── context.ts                      # ConversationContext 类型 + 默认值
│   ├── turn-handler.ts                 # 核心：每轮消息处理，判断当前状态→执行动作→推进状态
│   ├── info-extractor.ts               # NLU：用 LLM 从自然语言中提取结构化字段
│   └── session-store.ts                # 内存 Map（开发）/ Redis（生产）
│
├── agents/                             # Agent 层（大幅重构）
│   ├── base-agent.ts                   # 抽象基类（保留）
│   ├── gathering-agent.ts              # 生成追问话术（替换 preference-agent）
│   ├── transport-agent.ts              # 搜索高铁+航班，生成推荐排序（替换 flight-agent）
│   ├── hotel-agent.ts                  # 搜索酒店，综合评分，含备选（重构）
│   ├── itinerary-agent.ts              # 逐日行程规划（替换 activity-agent）
│   ├── local-transport-agent.ts        # 景点间交通方案（新增）
│   └── dining-agent.ts                 # 餐厅推荐（新增，含必点菜）
│
├── data-sources/                       # 数据源层（保留 + 扩展）
│   ├── types.ts                        # TravelDataSource 接口（保留，扩展搜索方法）
│   ├── amadeus-source.ts               # Amadeus 航班 API（保留）
│   ├── booking-source.ts               # Booking.com 酒店 API（保留）
│   ├── amap-source.ts                  # 高德 POI 景点/餐厅（保留）
│   ├── web-search-source.ts            # Web Search 通用搜索（保留）
│   ├── fallback-data-source.ts         # 降级兜底数据源（保留）
│   └── source-resolver.ts              # 新增：按数据类型选择最优数据源 + fallback 链
│
├── tools/                              # 工具层（新增，路由到 data-sources）
│   ├── registry.ts                     # TOOLS 数组，提供给 LLM tool_use
│   └── executor.ts                     # executeTool() → 调用 SourceResolver → 返回结构化数据
│
├── formatters/                         # 格式化层（新增）
│   ├── selection-card.ts               # 生成 SSE transport_options / hotel_options 数据
│   ├── day-plan.ts                     # 单日行程 → Markdown 文本
│   ├── final-plan.ts                   # 完整计划 → 流式 Markdown 分段输出
│   └── cost-summary.ts                 # 费用汇总格式化
│
├── orchestrator/                       # 编排层（大幅简化）
│   ├── conversation-orchestrator.ts    # 主编排：驱动对话状态机
│   └── planning-pipeline.ts            # 行程生成子流水线（并行搜索景点/餐厅/路线）
│
├── api/
│   ├── app.ts                          # Fastify 工厂
│   ├── routes.ts                       # 新路由（含 /select 接口）
│   ├── llm-client.ts                   # Anthropic 流式客户端（保留）
│   ├── tools.ts                        # 重写：对接 tools/registry + executor
│   └── stream-handler.ts               # 重构：嵌入对话状态机
│
├── types/
│   └── index.ts                        # 全部重写（见类型系统章节）
├── config/
│   └── settings.ts
└── public/
    └── chat.html                       # 重构：增加选择卡片 + 进度指示
```

**废弃文件**：`orchestrator/parallel.ts`（逻辑内聚到 planning-pipeline）、`orchestrator/budget-loop.ts`（预算由多轮对话自然控制，无需自动调整循环）、`agents/destination-agent.ts`（合并入 gathering-agent）。

**保留层**：`data-sources/` 目录整体保留，新增 `source-resolver.ts` 统一数据源选择逻辑。Agent 不直接调用 web_search，而是通过 SourceResolver 获取数据，Resolver 按优先级选择数据源（如火车 → 高德/web_search → fallback）。

---

## 核心数据流

### 完整对话时序

```
浏览器
  │ POST /api/chat                       → 创建会话，返回 sessionId
  │
  │ POST /api/chat/:sid  "我想去北京"     → SSE
  ▼
ConversationOrchestrator
  │ InfoExtractor.extract()              → { destination: "北京" }
  │ 状态: INIT → GATHERING_BASICS
  │ GatheringAgent.generateQuestion()    → "请问从哪出发？计划哪几天？几人同行？"
  ▼ SSE: text_delta, question

  │ POST /api/chat/:sid  "武汉，6.1-6.5，2人"
  ▼
  │ InfoExtractor.extract()              → { departureCity:"武汉", start:"6.1", end:"6.5", travelers:2 }
  │ 状态: GATHERING_BASICS → GATHERING_PREFERENCES
  │ GatheringAgent.generateQuestion()    → "预算大概多少？住宿偏好？想玩什么类型？"
  ▼ SSE: text_delta, question

  │ POST /api/chat/:sid  "总预算5000，住舒适型，想看胡同历史文化"
  ▼
  │ InfoExtractor.extract()              → { budget:5000, style:"comfort", interests:["胡同","历史"] }
  │ 状态: GATHERING_PREFERENCES → SEARCHING_TRANSPORT
  │ TransportAgent.run()
  │   └── search_trains(武汉→北京, 6.1) + search_trains(武汉→北京, 6.5返程)
  │   └── 筛选 G 次，推荐"去程10-12点出发+返程下午出发"
  │ 状态: SEARCHING_TRANSPORT → SELECTING_TRANSPORT
  ▼ SSE: text_delta("为您找到以下出行方案"), transport_options([...])

  │ POST /api/chat/:sid/select  { type:"transport", outbound:"G316", return:"G317" }
  ▼
  │ 记录选择，状态: SELECTING_TRANSPORT → SEARCHING_HOTELS
  │ HotelAgent.run()
  │   └── 推断核心区域：北新桥/鼓楼（胡同兴趣 + 北京西站到达）
  │   └── search_hotels(北京 东城区鼓楼附近, comfort, 250-450/晚)
  │ 状态: SEARCHING_HOTELS → SELECTING_HOTEL
  ▼ SSE: text_delta("为您推荐以下住宿"), hotel_options([推荐1个+备选2个])

  │ POST /api/chat/:sid/select  { type:"hotel", hotelId:"xxx" }
  ▼
  │ 记录选择，状态: SELECTING_HOTEL → PLANNING_ITINERARY
  │ PlanningPipeline.run()（并行）
  │   ├── AttractionAgent  → 搜索北京胡同/历史景点，按区域聚类
  │   ├── DiningAgent      → 每日三餐推荐（含必点菜）
  │   └── LocalTransportAgent → 景点间路线（地铁/打车/步行）
  │ ItineraryAgent.compose() → DayPlan[]
  │ 状态: PLANNING_ITINERARY → FINAL_OUTPUT
  ▼ SSE: text_delta(逐日流式输出), day_plan×5, cost_summary, done
```

---

## Agent 实现细节

### GatheringAgent（信息收集）

**职责**：在任意状态下，生成当前轮次最合适的追问话术。

**关键字段优先级**：

```
MUST_HAVE（阻塞推进）:  destination, departureCity, startDate, endDate, numTravelers
SHOULD_HAVE（影响质量）: budget, accommodationStyle, travelInterests
NICE_TO_HAVE（可推断）:  foodPreferences, transportPreference
```

**问题合并策略**：每轮最多问 3 个相关字段，合并成自然语句，不问重复字段。

```typescript
// 示例：GATHERING_BASICS 缺少 departureCity + dates + travelers
generateQuestion(missing: string[]): string {
  // → "请问从哪个城市出发？计划哪几天出行？几人同行呢？"
}
```

**推断逻辑**（避免冗余追问）：
- 说"历史文化"→ interests 包含 `["博物馆", "故宫", "胡同", "历史遗址"]`
- 说"舒适型"未给 budget → 推断 budget ≈ 人数 × 天数 × 600
- 说"周末"→ 推断最近的周六周日

---

### TransportAgent（交通搜索）

**搜索策略**：

| 出发城市→目的地 | 优先方案 | 备选方案 |
|----------------|---------|---------|
| 距离 ≤ 1500km | 高铁 G/D 次 | 飞机（考虑接驳时间后对比） |
| 距离 > 1500km | 飞机（经济舱） | 高铁（展示总耗时） |
| 无直达 | 转乘方案 | - |

**去程时间偏好推荐**：
- 推荐 10:00–12:00 出发（到达后当天可游玩）
- 备选 07:00–09:00（早班，适合行程紧凑的）
- 不推荐 18:00 后出发（到达太晚）

**返程时间偏好推荐**：
- 推荐 16:00–20:00 出发（不浪费最后半天）
- 若末日景点在市区 → 可推 14:00 后出发

**返回结构**：

```typescript
interface TransportOption {
  id: string
  mode: 'train' | 'flight'
  trainNo?: string          // G316
  flightNo?: string         // CA1234
  departStation: string     // 武汉站
  arriveStation: string     // 北京西站
  departTime: string        // 10:33
  arriveTime: string        // 14:36
  duration: string          // 4小时3分
  price: number             // 623
  note?: string             // "到达后可游玩半天"
  isRecommended: boolean
}

interface TransportSearchResult {
  outbound: TransportOption[]   // 去程候选（3-4个）
  return: TransportOption[]     // 返程候选（3-4个）
  totalCost: number             // 去程+返程价格合计
}
```

---

### HotelAgent（酒店搜索）

**区域推断逻辑**：

```
兴趣偏好 → 推荐住宿区域

胡同/历史/文化 → 东城区（东四、北新桥、鼓楼附近）
购物/现代/商业 → 朝阳区（三里屯、国贸附近）
自然/公园/休闲 → 海淀区（颐和园周边）
故宫/天安门    → 西城区（西单附近）
```

**综合评分公式**：

```
score = 地铁便利度×30 + 价格符合度×30 + 平台评分×25 + 景区区位×15

地铁便利度: ≤3分钟→满分, ≤8分钟→70分, >15分钟→0分
价格符合度: 在预算夜均价±20%内→满分, 超出20%→递减
```

**返回结构**：

```typescript
interface HotelOption {
  id: string
  name: string                               // 格林豪泰智选酒店（北新桥地铁站簋街店）
  pricePerNight: number                      // 366
  totalCost: number                          // 1464（4晚×1间）
  address: string
  nearestMetro: string                       // 5号线北新桥站，步行2分钟
  rating: number                             // 4.2
  pros: string[]                             // ["近鼓楼景区，步行可达", "装修干净"]
  cons: string[]                             // ["房间较小"]
  distanceToKeySpots: Record<string, string> // { "南锣鼓巷": "步行1.4km" }
  isRecommended: boolean
}
```

**选项数量**：1 个推荐 + 2 个备选（价格更低/位置更优/评分更高各一）。

---

### ItineraryAgent（逐日行程规划）

**景点聚类策略**：按地理位置将同区域景点排同一天，减少跨区移动。

**每日结构**：

| 时段 | 时间 | 策略 |
|------|------|------|
| 早上 | 09:00–12:00 | 体力消耗大的景点（爬长城、故宫步行） |
| 下午 | 13:00–17:00 | 漫步型（胡同、湖边、商业街） |
| 晚上 | 18:00–21:00 | 夜市/夜景/轻松活动 |

**特殊日处理**：
- **到达日**：只安排酒店附近轻松活动（如 16:00 后出发的短游），给出打车到酒店路线
- **离开日**：安排酒店周边景点，行程在 13:00 前结束，提前规划送站路线

**输出包含**（对标样例）：
- 景点间建议的步行串联路线（如"沿南锣鼓巷→黄瓦增幅财神庙→鼓楼东大街→鼓楼→钟楼"）
- 拍照机位建议
- 每段景点间交通方案（地铁路线+换乘站/打车价格/步行时间）
- 午餐和晚餐各一个推荐餐厅（含必点菜和人均价格）

---

### LocalTransportAgent（城市内交通）

**每段 A→B 移动输出三种方案**：

```typescript
interface TransportSegment {
  from: string
  to: string
  recommended: LocalRoute          // 推荐方案（加粗展示）
  alternatives: LocalRoute[]       // 备选 1-2 个
}

interface LocalRoute {
  mode: 'metro' | 'taxi' | 'bike' | 'walk'
  duration: string        // 50分钟
  cost: number            // 5
  route?: string          // 7号线→磁器口换乘→5号线，共14站
  note?: string           // 高峰期容易堵车，建议早上打车
}
```

**推荐逻辑**：
- ≤ 2km → 推荐步行或共享单车
- 2–10km 且有直达或 1 次换乘地铁 → 推荐地铁
- > 10km 或无便捷地铁 → 推荐打车
- 晚上末程返回酒店 → 推荐打车（减少疲惫）

---

### DiningAgent（餐厅推荐）

**搜索策略**：通过 `SourceResolver.resolve('restaurant', { location, mealType, cuisine })` 搜索，优先使用高德 POI，降级使用 web_search 解析大众点评/小红书内容。

```typescript
interface RestaurantRec {
  name: string              // 鸭儿李记涮肉（什刹海店）
  cuisine: string           // 北京铜锅涮肉
  pricePerPerson: number    // 106
  mustOrder: string[]       // ["羊肉", "麻酱饼", "冻豆腐"]
  address: string           // 什刹海荷花市场西侧
  openHours: string         // 11:00–22:00
  note: string              // 老北京味道，建议提前预约
  returnRoute?: string      // 建议打车回酒店，预计23元
}
```

---

## 工具系统

### 工具注册表 (`tools/registry.ts`)

```typescript
export const TOOLS = [
  {
    name: "search_trains",
    description: "搜索两城市之间的高铁/动车班次",
    input_schema: {
      required: ["from", "to", "date"],
      properties: {
        from:      { type: "string", description: "出发城市，如 武汉" },
        to:        { type: "string", description: "到达城市，如 北京" },
        date:      { type: "string", description: "YYYY-MM-DD" },
        trainType: { type: "string", enum: ["G", "D", "all"], default: "G" }
      }
    }
  },
  {
    name: "search_hotels",
    description: "搜索城市指定区域的酒店",
    input_schema: {
      required: ["city", "area", "checkIn", "checkOut"],
      properties: {
        city:      { type: "string" },
        area:      { type: "string", description: "如 东城区北新桥附近" },
        checkIn:   { type: "string" },
        checkOut:  { type: "string" },
        priceMax:  { type: "number" },
        style:     { type: "string", enum: ["budget", "comfort", "luxury"] },
        numRooms:  { type: "number" }
      }
    }
  },
  {
    name: "search_attractions",
    description: "搜索目的地的景点信息，包括开放时间、门票、游览时间",
    input_schema: {
      required: ["city", "keywords"],
      properties: {
        city:     { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        area:     { type: "string" }
      }
    }
  },
  {
    name: "search_restaurants",
    description: "搜索景点附近的餐厅，含推荐菜和人均价格",
    input_schema: {
      required: ["location", "meal"],
      properties: {
        location:       { type: "string" },
        meal:           { type: "string", enum: ["lunch", "dinner"] },
        cuisine:        { type: "string" },
        pricePerPerson: { type: "number" }
      }
    }
  },
  {
    name: "get_local_route",
    description: "获取城市内两地点之间的地铁/打车/步行方案",
    input_schema: {
      required: ["from", "to", "city"],
      properties: {
        from:  { type: "string" },
        to:    { type: "string" },
        city:  { type: "string" },
        modes: { type: "array", items: { type: "string", enum: ["metro", "taxi", "walk", "bike"] } }
      }
    }
  }
]
```

### 工具执行器 (`tools/executor.ts`)

**工具通过 `SourceResolver` 路由到最优数据源**，保留现有 API 集成：

```typescript
async executeTool(name: string, input: any): Promise<ToolResult> {
  switch (name) {
    case 'search_trains':
      // SourceResolver.resolve('train', params)
      // 优先链：高德/web_search → fallback-data-source

    case 'search_hotels':
      // SourceResolver.resolve('hotel', params)
      // 优先链：Booking.com API → web_search → fallback

    case 'search_attractions':
      // SourceResolver.resolve('attraction', params)
      // 优先链：高德 POI → web_search → fallback

    case 'search_restaurants':
      // SourceResolver.resolve('restaurant', params)
      // 优先链：高德 POI → web_search → fallback

    case 'get_local_route':
      // SourceResolver.resolve('route', params)
      // 优先链：高德路线规划 → web_search → fallback
  }
}
```

### SourceResolver (`data-sources/source-resolver.ts`)

**职责**：按数据类型选择最优数据源，管理 fallback 链和超时。

```typescript
interface SourceResolverOptions {
  timeout: number           // 单次数据源超时，默认 SEARCH_TIMEOUT_MS
  enableFallback: boolean   // 主数据源失败后是否尝试 fallback
}

class SourceResolver {
  constructor(sources: TravelDataSource[], options?: SourceResolverOptions)

  async resolve(type: DataType, params: SearchParams): Promise<SearchResult> {
    // 1. 按 type 筛选支持该搜索的数据源（已注册的方法非空）
    // 2. 按优先级排序（配置或硬编码）
    // 3. 依次尝试，首次成功即返回
    // 4. 全部失败 → 返回 fallback-data-source 的兜底数据
    // 5. 超时控制：单个数据源超时后自动切换下一个
  }
}
```

**数据源优先级配置**（可通过环境变量覆盖）：

| 数据类型 | 优先级 1 | 优先级 2 | 兜底 |
|---------|---------|---------|------|
| 航班 | Amadeus API | web_search + LLM 解析 | fallback-data-source |
| 酒店 | Booking.com API | web_search + LLM 解析 | fallback-data-source |
| 火车 | web_search + LLM 解析 | - | fallback-data-source |
| 景点 | 高德 POI | web_search + LLM 解析 | fallback-data-source |
| 餐厅 | 高德 POI | web_search + LLM 解析 | fallback-data-source |
| 路线 | 高德路线规划 | web_search + LLM 解析 | fallback-data-source |

---

## 对话上下文管理

### ConversationContext

```typescript
interface ConversationContext {
  sessionId: string
  state: ConversationState
  version: number                // 乐观锁版本号，每次写入 +1
  createdAt: Date
  updatedAt: Date

  // === 错误追踪 ===
  lastError?: {                  // 最近一次错误
    state: ConversationState     // 出错时的状态
    message: string
    retryCount: number           // 已重试次数
    timestamp: Date
  }

  // === 收集到的信息 ===
  destination?: string             // 北京
  departureCity?: string           // 武汉
  startDate?: string               // 2025-06-01
  endDate?: string                 // 2025-06-05
  numDays?: number                 // 5
  numTravelers?: number            // 2
  budget?: number                  // 5000
  accommodationStyle?: StyleType   // comfort
  travelInterests?: string[]       // ["胡同", "历史", "文化"]
  foodPreferences?: string[]

  // === 搜索结果缓存 ===
  transportOptions?: TransportSearchResult
  hotelOptions?: HotelOption[]
  attractions?: Attraction[]

  // === 用户选择 ===
  selectedOutbound?: TransportOption
  selectedReturn?: TransportOption
  selectedHotel?: HotelOption

  // === 规划结果 ===
  dayPlans?: DayPlan[]
  totalCost?: BudgetBreakdown

  // === 对话控制 ===
  messageHistory: Message[]
  pendingField?: string            // 当前在等待用户填写的字段，用于追问
}
```

### Session Store (`conversation/session-store.ts`)

```typescript
interface SessionStore {
  get(sessionId: string): Promise<ConversationContext | null>
  set(sessionId: string, ctx: ConversationContext): Promise<void>  // 乐观锁：检查 ctx.version
  delete(sessionId: string): Promise<void>
  refreshTtl(sessionId: string): Promise<void>  // 用户活跃时延长 TTL
}

// 实现1：MemoryStore（开发环境，Map<string, ConversationContext>，定时扫描清理过期）
// 实现2：RedisStore（生产环境，JSON 序列化，TTL 2h，每次活跃时 refresh）
// 工厂：SESSION_STORE=memory|redis 环境变量控制

// 乐观锁机制：
// set() 内部伪代码：
//   const current = await get(sessionId)
//   if (current && current.version !== ctx.version - 1) throw new VersionConflictError()
//   await write(sessionId, ctx)
```

---

## API 层重构

### 路由设计

```
POST   /api/chat                     # 创建新会话 → { sessionId }
POST   /api/chat/:sid                # 发送消息 → SSE 流
POST   /api/chat/:sid/select         # 提交用户选择（交通/酒店）→ SSE 流
GET    /api/chat/:sid/state          # 查询当前会话状态（调试用）
DELETE /api/chat/:sid                # 清除会话
```

### `/api/chat/:sid/select` 接口

**交互流程**：前端发送 POST 请求 → 后端返回 SSE 流（包含后续搜索/推送的完整过程）。

```
前端                              后端
  │ POST /api/chat/:sid/select     → 解析选择，更新 context
  │                                  → 推进状态，触发下一步搜索
  │ ← SSE: state_change             ← 状态变化通知
  │ ← SSE: text_delta               ← "正在为您搜索酒店..."
  │ ← SSE: hotel_options / ...      ← 搜索结果推送
  │ ← SSE: done                     ← 流结束
```

```typescript
// 请求体
interface SelectRequest {
  type: 'transport' | 'hotel'
  action?: 'confirm' | 'rescan' | 'change_transport' | 'change_hotel'  // 默认 confirm
  // type=transport + confirm 时：
  outboundId?: string    // 去程班次 id
  returnId?: string      // 返程班次 id
  // type=hotel + confirm 时：
  hotelId?: string
}

// 响应：SSE 流（与 /api/chat/:sid 相同的 SSE 事件格式）
// action=rescan → 忽略 id 字段，重新触发搜索
// action=change_transport → 回退到 SELECTING_TRANSPORT，重新搜索
// action=change_hotel → 回退到 SELECTING_HOTEL，重新搜索
```

### SSE 事件类型（完整版）

| 事件 | 数据结构 | 说明 |
|------|---------|------|
| `text_delta` | `{ text: string }` | 打字机流式文字 |
| `question` | `{ text: string, fields: string[] }` | 需要用户回答 |
| `transport_options` | `{ outbound: TransportOption[], return: TransportOption[] }` | 展示交通选择卡 |
| `hotel_options` | `{ options: HotelOption[] }` | 展示酒店选择卡 |
| `planning_start` | `{}` | 开始生成行程 |
| `day_plan` | `{ day: DayPlan }` | 逐日推送（流式） |
| `cost_summary` | `{ breakdown: BudgetBreakdown }` | 费用汇总 |
| `state_change` | `{ state: ConversationState }` | 状态变化（前端进度条） |
| `error` | `{ error: string, recoverable: boolean, retryAfter?: number }` | 错误（可恢复时前端显示重试按钮） |
| `retry` | `{ attempt: number, maxAttempts: number }` | 自动重试中 |
| `done` | `{}` | 流结束 |

### 前端重构要点 (`public/chat.html`)

**新增 UI 组件**：

1. **进度条**：8 步对话进度，当前步骤高亮（收集信息→搜索交通→选择交通→搜索酒店→选择酒店→规划行程→输出完成）

2. **交通选择卡片**（`transport_options` 事件触发）：
   ```
   ┌──────────────────────────────────────────┐
   │ 去程选项              返程选项             │
   │ ○ G316 10:33→14:36  ○ G315 16:00→20:05 │
   │   武汉站→北京西 623元   ★推荐             │
   │ ○ G520 07:00→11:15  ○ G521 18:30→22:35 │
   │   武汉站→北京西 623元                     │
   │            [ 确认选择 ]                   │
   └──────────────────────────────────────────┘
   ```

3. **酒店选择卡片**（`hotel_options` 事件触发）：
   ```
   ┌─────────────────────────────────────────────┐
   │ ★ 推荐：格林豪泰北新桥  366元/晚  1464元合计 │
   │   5号线北新桥站，步行2分钟  ★4.2             │
   │   优：近鼓楼，步行可达  缺：房间较小          │
   │ ─────────────────────────────────────────   │
   │   备选A：xxx酒店  280元/晚  装修稍旧          │
   │   备选B：xxx酒店  420元/晚  装修新，稍远地铁   │
   │              [ 选择推荐 ]  [ 选其他 ]         │
   └─────────────────────────────────────────────┘
   ```

4. **行程卡片**（`day_plan` 事件触发，逐日追加）：可折叠，含费用小计。

---

## 类型系统（完整版）

```typescript
// ── 状态机 ──
type ConversationState =
  | 'INIT'
  | 'GATHERING_BASICS'
  | 'GATHERING_PREFERENCES'
  | 'SEARCHING_TRANSPORT'
  | 'SELECTING_TRANSPORT'
  | 'SEARCHING_HOTELS'
  | 'SELECTING_HOTEL'
  | 'PLANNING_ITINERARY'
  | 'FINAL_OUTPUT'
  | 'ERROR'                        // 搜索失败/超时/解析异常

type StyleType = 'budget' | 'comfort' | 'luxury'

// ── 交通 ──
interface TransportOption {
  id: string
  mode: 'train' | 'flight'
  trainNo?: string
  departStation: string
  arriveStation: string
  departTime: string      // HH:mm
  arriveTime: string
  duration: string        // "4小时3分"
  price: number
  note?: string
  isRecommended: boolean
}

interface TransportSearchResult {
  outbound: TransportOption[]
  return: TransportOption[]
}

// ── 酒店 ──
interface HotelOption {
  id: string
  name: string
  pricePerNight: number
  totalCost: number
  address: string
  nearestMetro: string    // "5号线北新桥站，步行2分钟"
  rating: number
  pros: string[]
  cons: string[]
  distanceToKeySpots: Record<string, string>
  isRecommended: boolean
}

// ── 景点 ──
interface Attraction {
  name: string
  area: string
  visitDuration: string   // "2-3小时"
  ticketPrice: number
  openHours: string
  tags: string[]          // ["胡同", "历史", "步行"]
  photoSpots?: string[]
}

// ── 逐日行程 ──
interface TimeBlock {
  startTime: string
  attractions: Attraction[]
  walkingRoute?: string   // "沿南锣鼓巷→钟鼓楼→什刹海串联游览"
  photoSpots?: string[]
  transportToNext?: LocalRoute
}

interface DayPlan {
  date: string
  dayIndex: number
  theme: string           // "出发日 · 胡同初探"
  isArrivalDay: boolean
  isDepartureDay: boolean
  morning?: TimeBlock
  afternoon?: TimeBlock
  evening?: { description: string; suggestion: string }
  lunch?: RestaurantRec
  dinner: RestaurantRec
  dailyCost: number
  dailyCostBreakdown: {
    transport: number; tickets: number; meals: number; misc: number
  }
}

// ── 餐厅 ──
interface RestaurantRec {
  name: string
  cuisine: string
  pricePerPerson: number
  mustOrder: string[]
  address: string
  openHours: string
  note?: string
  returnRoute?: string    // "建议打车回酒店，约23元"
}

// ── 城市内交通 ──
interface LocalRoute {
  mode: 'metro' | 'taxi' | 'walk' | 'bike'
  duration: string
  cost: number
  route?: string          // "7号线磁器口→换乘5号线北新桥，共14站"
  note?: string
}

// ── 预算汇总 ──
interface BudgetBreakdown {
  transport: number        // 去程+返程交通
  hotel: number            // 住宿合计
  tickets: number          // 景点门票合计
  meals: number            // 餐饮合计
  localTransport: number   // 城市内交通合计
  misc: number             // 杂项
  total: number
  budget: number           // 用户设定预算
  isOverBudget: boolean
}
```

---

## 配置

在原有基础上新增：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_STORE` | `memory` | `memory` \| `redis` |
| `REDIS_URL` | - | Redis 连接（生产）|
| `SESSION_TTL_MS` | `7200000` | 会话超时（默认 2h） |
| `MAX_TRANSPORT_OPTIONS` | `4` | 每方向展示班次数 |
| `MAX_HOTEL_OPTIONS` | `3` | 展示酒店数（推荐1+备选2）|
| `SEARCH_TIMEOUT_MS` | `10000` | 单次数据源搜索超时 |
| `MAX_CONVERSATION_TURNS` | `20` | 防止对话无限延伸 |
| `MAX_ERROR_RETRIES` | `2` | 搜索失败自动重试次数 |
| `SOURCE_FALLBACK_ENABLED` | `true` | 主数据源失败后是否尝试 fallback 链 |

---

## 原架构 → 新架构 迁移映射

| 原文件 | 状态 | 新位置/说明 |
|--------|------|------------|
| `agents/preference-agent.ts` | **替换** | `agents/gathering-agent.ts` + `conversation/info-extractor.ts` |
| `agents/destination-agent.ts` | **废弃** | 目的地由用户直接说出，无需 Agent 推荐 |
| `agents/flight-agent.ts` | **重构** | `agents/transport-agent.ts`，新增高铁支持 |
| `agents/hotel-agent.ts` | **重构** | 增加区域推断 + 真实搜索 + 选择卡格式 |
| `agents/activity-agent.ts` | **替换** | `agents/itinerary-agent.ts` + `agents/dining-agent.ts` |
| `agents/budget-agent.ts` | **简化** | 保留纯汇总逻辑，去除自动削减循环 |
| `orchestrator/pipeline.ts` | **替换** | `orchestrator/conversation-orchestrator.ts` |
| `orchestrator/parallel.ts` | **内聚** | 逻辑移入 `orchestrator/planning-pipeline.ts` |
| `orchestrator/budget-loop.ts` | **废弃** | 预算由多轮对话自然控制 |
| `api/tools.ts` | **重写** | 对接新 `tools/registry.ts` + `tools/executor.ts` |
| `api/stream-handler.ts` | **重构** | 嵌入对话状态机，处理 /select 路由 |
| `public/chat.html` | **重构** | 增加选择卡片 + 进度条 + 折叠行程卡 + 回退按钮 |
| `types/index.ts` | **重写** | 见类型系统章节 |
| `data-sources/types.ts` | **保留+扩展** | 增加 `DataType` 枚举和 fallback 相关搜索方法签名 |
| `data-sources/source-resolver.ts` | **新增** | 数据源选择器，管理优先级链和超时 |

---

## 分阶段实施计划

### Phase 1：对话状态机 + 信息收集

**目标**：实现多轮对话骨架，用户通过自然语言逐步提供旅行信息。

**改动范围**：
- 新增 `conversation/` 层（state-machine、context、turn-handler、info-extractor、session-store）
- 新增 `orchestrator/conversation-orchestrator.ts`
- 新增 `agents/gathering-agent.ts`（替换 preference-agent）
- 重构 `api/stream-handler.ts`（嵌入状态机）
- 重构 `public/chat.html`（进度条 + 追问 UI）

**不改动的**：
- `data-sources/` 保持原样
- `agents/flight-agent.ts`、`agents/hotel-agent.ts`、`agents/activity-agent.ts`、`agents/budget-agent.ts` 保持原样
- `api/tools.ts` 中 `plan_travel` 工具暂时保留

**验证标准**：
- 用户输入"我想去北京" → 系统追问出发城市/日期/人数
- 用户补充信息后 → 系统继续追问预算/偏好
- 信息收集完毕 → 调用原有 Pipeline 生成行程（保持现有体验）
- 中途刷新页面 → 从 SessionStore 恢复上下文，继续对话

**预计文件变更**：~8 新增，~3 重构

---

### Phase 2：交通/酒店选择卡片 + SourceResolver

**目标**：在交通和酒店搜索后暂停，展示选项卡片让用户决策。

**改动范围**：
- 新增 `data-sources/source-resolver.ts`
- 扩展 `data-sources/types.ts`（增加 DataType、路线搜索方法）
- 新增 `agents/transport-agent.ts`（替换 flight-agent，接入 SourceResolver）
- 重构 `agents/hotel-agent.ts`（增加区域推断 + SourceResolver）
- 新增 `formatters/selection-card.ts`
- 新增 `api/routes.ts` 中 `/select` 路由
- 重构 `public/chat.html`（交通/酒店选择卡片 + 回退按钮）
- 简化 `agents/budget-agent.ts`（去除自动削减循环）

**废弃**：
- `agents/flight-agent.ts`（被 transport-agent 替换）
- `agents/destination-agent.ts`（合并入 gathering-agent）
- `orchestrator/pipeline.ts`（被 conversation-orchestrator 替换）
- `orchestrator/budget-loop.ts`（预算由对话控制）

**验证标准**：
- 信息收集后 → 自动搜索交通 → 展示高铁/航班选择卡
- 用户选择交通 → 搜索酒店 → 展示酒店选择卡
- 用户可点击"重新搜索"或"更换交通"回退
- 数据源优先级链正常工作（主源失败自动 fallback）
- 搜索超时 → 展示友好提示 + 降级结果

**预计文件变更**：~4 新增，~5 重构，~4 废弃

---

### Phase 3：行程精细化

**目标**：生成逐日精细化行程，包含餐厅推荐和城市内交通方案。

**改动范围**：
- 新增 `agents/itinerary-agent.ts`（替换 activity-agent）
- 新增 `agents/dining-agent.ts`
- 新增 `agents/local-transport-agent.ts`
- 新增 `formatters/day-plan.ts`、`formatters/final-plan.ts`、`formatters/cost-summary.ts`
- 新增 `orchestrator/planning-pipeline.ts`（替换 parallel.ts）
- 重构 `public/chat.html`（行程卡片 + 折叠 + 费用汇总）

**废弃**：
- `agents/activity-agent.ts`（被 itinerary + dining 替换）
- `orchestrator/parallel.ts`（内聚到 planning-pipeline）

**验证标准**：
- 用户选择酒店后 → 并行搜索景点/餐厅/路线
- 输出包含：景点步行串联路线、拍照机位、景点间交通方案、餐厅推荐（含必点菜）
- 到达日/离开日有特殊处理
- 费用汇总准确（交通+住宿+门票+餐饮+市内交通）
- 流式输出（逐日推送）

**预计文件变更**：~7 新增，~2 重构，~2 废弃

---

### Phase 间兼容性保证

每个 Phase 完成后系统可独立运行：
- **Phase 1 完成后**：多轮收集信息 → 调用旧 Pipeline → 输出粗粒度行程（体验已提升）
- **Phase 2 完成后**：多轮收集 → 用户选择交通/酒店 → 输出粗粒度行程（可控性提升）
- **Phase 3 完成后**：完整体验，逐日精细化行程
