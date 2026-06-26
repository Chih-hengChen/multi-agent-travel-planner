# P0-B 接口契约

> 关联:`docs/agent-loop-redesign.md` §3.2 / §5 / §10
> 立项:2026-06-18
> 状态:**Hard contract** — P0-B 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:把 P0-B 工具系统重做涉及的所有工具接口、迁移路径、Schema 抽取方案全部锁定

---

## 0. 文档定位

P0-A 已完成 Agent Loop 主框架 + 12 工具名在 `policy.ts` 的 phase gating 声明。但工具实现分散在两处:

| 位置 | 工具 | 状态 |
|------|------|------|
| `tools/definitions/` | `collect_preferences`, `plan_travel`, `search_xhs_notes`, `search_web`, `search_trains`, `search_flights`, `search_hotels`, `search_attractions` | 旧 registry 体系,`plan_travel` 走旧 Pipeline |
| `LLMPlanAgent.buildToolDefs()` | `search_attractions`, `search_restaurants`, `search_xhs_notes`, `search_weather`, `search_travel_guides` | 内联,不经过 ToolRegistry |
| `tools/definitions/` (P0-A 新增) | `plan_transit`, `finalize_plan`, `plan-schema.ts` | 正确实现,Agent Loop 可用 |

P0-B 的任务:统一到这 12 个标准工具定义,消除双重实现,删死代码,补完所有工具的 DataSource 接入。

**本文档定义**:
- §1:8 个工具接口契约(4 个 LLMPlanAgent 迁移 + 2 个新增 + 2 个改造)
- §2:共享 Schema 抽取方案
- §3:LLMPlanAgent 切换到 ToolRegistry 的兼容策略
- §4:死代码清理范围
- §5:测试计划
- §6:分步实施 plan

---

## 1. 工具接口契约

### 1.1 search_baike(新增)

从百度百科获取目的地核心知识(城市概况、历史文化、气候、交通、必游景点)。

```ts
// src/tools/definitions/search-baike.ts
export const searchBaikeTool: RegisteredTool = {
  name: "search_baike",
  description: "百科检索:获取目的地城市概况、历史文化、气候、交通、必游景点。用于 searching 阶段建立城市认知。",
  input_schema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名,如:东京" },
    },
    required: ["city"],
  },
  metadata: { phase: ["searching"], timeout: 15_000 },

  async execute(input, ctx) {
    // L0: WebSearch 搜 "{city} 百度百科" → 提取正文前 1500 字
    const webSearch = new WebSearchSource(log);
    const raw = await webSearch.getCityKnowledge(input.city);

    if (!raw) {
      // L1: 降级到 LLM 知识(返回空,LLM 用自己的训练知识)
      return { success: true, fallbackLevel: 1, data: { summary: "", source: "llm_generated" } };
    }

    return {
      success: true,
      fallbackLevel: 0,
      data: {
        summary: raw.slice(0, 2000),
        source: "web_search_baidu",
        _full_text_stored: false,
      },
    };
  },
};
```

**降级链**(已在 `policy.ts` 声明):`baike_api` → `web_search_baidu` → `llm_generated`

**写 state 字段**:`baikeKnowledge = result.summary`

**trace 格式**:
```jsonl
{"type":"tool_exec","tool":"search_baike","duration_ms":1200,"fallback_level":0,"data_summary":{"city":"东京","len":1850,"source":"web_search_baidu"}}
```

### 1.2 search_weather(从 LLMPlanAgent 迁移)

```ts
// src/tools/definitions/search-weather.ts
export const searchWeatherTool: RegisteredTool = {
  name: "search_weather",
  description: "查询目的地实时天气和未来天气预报。用于行程安排、穿衣建议、户外活动决策。",
  input_schema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名" },
    },
    required: ["city"],
  },
  metadata: { phase: ["searching"], timeout: 10_000 },

  async execute(input, ctx) {
    // L0: 高德天气 API
    try {
      const weatherSource = new AmapWeatherSource();
      const result = await weatherSource.getFullWeather(input.city);
      if (result) {
        const summary = buildSummary(result);
        return { success: true, fallbackLevel: 0, data: { ...result, summary } };
      }
    } catch { /* 降级 */ }

    // L1: web_search "{city} 天气预报"
    return { success: true, fallbackLevel: 1, data: { summary: "天气数据暂不可用" } };
  },
};
```

**降级链**:`amap_weather` → `web_search`

**写 state 字段**:`weather = result`(WeatherSummary 类型)

**迁移变更**:LLMPlanAgent 的 `executeTool("search_weather", ...)` 逻辑整体抽出到工具定义文件。

### 1.3 search_restaurants(迁移 + 两阶段改造)

P0-B 最复杂的工具。当前 LLMPlanAgent 只有 `meal_type` + `preference` 参数,需加 `scope` 支持两阶段。

```ts
// src/tools/definitions/search-restaurants.ts
export const searchRestaurantsTool: RegisteredTool = {
  name: "search_restaurants",
  description: `搜索餐厅。
【searching 阶段】用 scope=city,获取城市热门餐厅画像。
【planning 阶段】用 scope=attraction + near=<景点名>,搜景点周边 1500m 餐厅用于行程衔接。
过滤规则:排除连锁品牌(除非用户显式要求)、本地特色 <=60%。`,

  input_schema: {
    type: "object",
    properties: {
      city:       { type: "string", description: "城市名" },
      scope:      { type: "string", enum: ["city", "attraction"], description: "搜索范围:city=城市级热门 / attraction=景点周边" },
      near:       { type: "string", description: "scope=attraction 时必填:景点名或地址(用于高德周边搜索)" },
      mealType:   { type: "string", enum: ["breakfast", "lunch", "dinner", "any"], description: "餐型,默认 any" },
      preference: { type: "string", enum: ["local_specialties", "trending", "mixed"], description: "餐饮偏好,默认 local_specialties" },
      maxResults: { type: "number", description: "最多返回数,默认 8" },
    },
    required: ["city"],
  },

  metadata: { phase: ["searching", "planning"], timeout: 15_000 },

  async execute(input, ctx) {
    const scope = input.scope ?? "city";
    if (scope === "attraction") return executeAttractionScope(input, ctx);
    return executeCityScope(input, ctx);
  },
};
```

#### scope=city(城市级)

```ts
async function executeCityScope(input, ctx) {
  // L0: 高德 POI 城市热门餐饮(category=餐饮, sortrule=weight)
  const { result: amapResults, waitMs } = await callAmap(async () =>
    amapSource.searchPoi({ city: input.city, category: "餐饮", sortrule: "weight" })
  );

  // L1 同源融合:从 ctx.state.xhsNotes 里匹配餐厅名/美食相关笔记
  const merged = mergeAmapWithXhs(amapResults, ctx.state.xhsNotes ?? []);

  // 过滤:排除连锁、本地特色 <=60%
  const filtered = filterRestaurants(merged, ctx.state.preferences!);
  const ranked = rerankRestaurants(filtered, ctx.state.preferences!);

  const scores: Record<string, number> = {};
  for (const r of ranked) scores[r.name] = r.score;

  return {
    success: true, fallbackLevel: 0,
    data: { scope: "city", items: ranked.slice(0, input.maxResults ?? 12), scores, amapWaitMs: waitMs },
  };
}
```

#### scope=attraction(景点级)

```ts
async function executeAttractionScope(input, ctx) {
  // L0a: 从 state 已有数据按 near 名查坐标(零成本,覆盖境外)
  const coords = findCoordsByName(input.near, ctx.state);
  if (!coords) {
    return { success: false, error: `找不到景点"${input.near}"的坐标,请确认景点名称。` };
  }

  // L0b: 高德 POI 周边搜索(radius=1500m)
  const { result: amapResults, waitMs } = await callAmap(async () =>
    amapSource.searchAround({ location: `${coords.lng},${coords.lat}`, radius: 1500, category: "餐饮", keywords: input.mealType ?? "" })
  );

  const filtered = filterRestaurants(amapResults, ctx.state.preferences!);
  const ranked = rerankRestaurants(filtered, ctx.state.preferences!);

  // 缓存(景点+mealType, TTL 5min)
  const cacheKey = `${input.near}:${input.mealType ?? "any"}`;
  cacheRestaurants(cacheKey, ranked);

  const scores: Record<string, number> = {};
  for (const r of ranked) scores[r.name] = r.score;

  return {
    success: true, fallbackLevel: 0,
    data: { scope: "attraction", near: input.near, items: ranked.slice(0, input.maxResults ?? 8), scores, amapWaitMs: waitMs },
  };
}
```

**降级链**:`amap_poi` → `xhs_service` → `web_search` → `rag_travel_guides`

**写 state 字段**:
- `scope=city` → `candidateRestaurants`(append, dedupe by name) + `rerankScores`
- `scope=attraction` → `planningRestaurants[near]`(append, dedupe) + `rerankScores`

**PRECONDITIONS**(见 `p0-a-contracts.md` §1.3):
```ts
search_restaurants: {
  check: (c, s) => c.input.scope !== "attraction" || (s.candidateAttractions?.length ?? 0) > 0,
  desc: "scope=attraction 时 candidateAttractions 不为空",
},
```

**关键辅助函数**:
```ts
const CHAIN_BRANDS = new Set(["麦当劳", "肯德基", "星巴克", "海底捞", "必胜客", "汉堡王", "赛百味"]);

function filterRestaurants(list: Activity[], prefs: UserPreferences): Activity[] {
  return list.filter(r => {
    const isChain = CHAIN_BRANDS.has(r.name);
    if (isChain && !prefs.preferredHotelBrands?.length) return false;
    if (prefs.dislikedFoods?.some(f => r.name.includes(f))) return false;
    return true;
  });
}

function rerankRestaurants(list: Activity[], prefs: UserPreferences): Activity[] {
  const localCap = Math.ceil(list.length * 0.6);
  let localCount = 0;
  return list
    .map(r => ({ ...r, score: scoreRestaurant(r, prefs) }))
    .sort((a, b) => b.score - a.score)
    .filter(r => {
      if (isLocalSpecialty(r, prefs.destination)) return localCount++ < localCap;
      return true;
    });
}
```

### 1.4 search_travel_guides(从 LLMPlanAgent 迁移)

```ts
// src/tools/definitions/search-travel-guides.ts
export const searchTravelGuidesTool: RegisteredTool = {
  name: "search_travel_guides",
  description: "RAG 旅行攻略检索。从本地攻略语料库搜索景点攻略、美食推荐、行程路线、交通贴士。",
  input_schema: {
    type: "object",
    properties: {
      city:       { type: "string", description: "目标城市" },
      query:      { type: "string", description: "自然语言查询,如:故宫一日游攻略" },
      category:   { type: "string", enum: ["attraction", "food", "itinerary", "tips", "all"], description: "类别过滤,默认 all" },
      maxResults: { type: "number", description: "最多返回段落数,默认 5" },
    },
    required: ["city", "query"],
  },
  metadata: { phase: ["searching", "planning"], timeout: 10_000 },

  async execute(input, ctx) {
    try {
      const rag = await getRagSource();
      const text = await rag.formatForLlm({
        city: input.city, query: input.query,
        category: input.category ?? "all", maxResults: input.maxResults ?? 5,
      });
      if (text) return { success: true, fallbackLevel: 0, data: { guides: text } };
    } catch { /* L1 降级 */ }
    return { success: true, fallbackLevel: 1, data: { guides: "攻略库暂不可用。" } };
  },
};
```

**降级链**:`rag_vector` → `rag_keyword_fallback`

**写 state 字段**:不写(结果作为 tool_result 直接回传 LLM)

### 1.5 search_hotels(geoConstraint 改造)

当前 `search-hotels.ts` 已有基础实现,需新增 `geoConstraint` 相关字段。

```ts
// 在现有 input_schema 基础上新增:
{
  // ... 现有:city / check_in / check_out / adults / max_price_per_night / max_star_rating

  preferredArea:  { type: "string", description: "用户指定区域,如:故宫附近、朝阳区" },
  keyAttractions: { type: "array", items: { type: "string" }, description: "planning 阶段已选景点名称" },
  geoConstraint: {
    type: "object",
    properties: {
      maxDistanceKm: { type: "number", description: "离 keyAttractions 几何中心的最大距离,默认 5" },
      preferNear:    { type: "string", enum: ["transit", "center"], description: "偏向地铁站 / 市中心" },
    },
  },
  preferredBrands: { type: "array", items: { type: "string" }, description: "偏好酒店品牌" },
}
```

**execute 改造**:
```ts
async execute(input, ctx) {
  // 1. 现有逻辑:BookingSource.searchHotels(...) + AmapSource.searchPoi(酒店)
  let hotels = await resolver.resolveHotels({...});

  // 2. geoConstraint 过滤(新增,optional)
  if (input.geoConstraint && input.keyAttractions?.length) {
    const center = computeGeometricCenter(input.keyAttractions, ctx.state);
    hotels = hotels.filter(h => haversine(h.location, center) <= (input.geoConstraint.maxDistanceKm ?? 5));
    if (input.geoConstraint.preferNear === "transit") {
      hotels.sort((a, b) => (a.distanceToMetro ?? 999) - (b.distanceToMetro ?? 999));
    } else if (input.geoConstraint.preferNear === "center") {
      hotels.sort((a, b) => a.distanceToCenterKm - b.distanceToCenterKm);
    }
  }

  // 3. preferredArea / preferredBrands 过滤
  if (input.preferredArea) hotels = filterByArea(hotels, input.preferredArea);
  if (input.preferredBrands?.length) {
    hotels = hotels.filter(h => input.preferredBrands!.some(b => h.name.includes(b)));
  }

  return { success: true, data: { hotels, summary }, sources };
}
```

**computeGeometricCenter**:
```ts
function computeGeometricCenter(names: string[], state: AgentState): { lat: number; lng: number } {
  const attractions = state.candidateAttractions ?? [];
  const matched = attractions.filter(a => names.some(n => a.name.includes(n)));
  if (!matched.length) return { lat: 0, lng: 0 };
  return {
    lat: matched.reduce((s, a) => s + a.location.lat, 0) / matched.length,
    lng: matched.reduce((s, a) => s + a.location.lng, 0) / matched.length,
  };
}
```

**降级链**(不变):`booking_api` → `amap_poi` → `web_search`

**反向兼容**:geoConstraint / preferredArea / keyAttractions 全部 optional,不传时行为与当前完全一致。

### 1.6 search_xhs(渐进抓取改造)

当前工具名叫 `search_xhs_notes`,需重命名为 `search_xhs`(与 `policy.ts` 一致),并实现渐进抓取。

```ts
// src/tools/definitions/search-xhs.ts(重写)
export const searchXhsTool: RegisteredTool = {
  name: "search_xhs",
  description: "小红书笔记搜索。默认抓 30 篇,不够再抓 30(渐进式)。提供真实游客评价、避坑提示、小众玩法。",
  input_schema: {
    type: "object",
    properties: {
      query:       { type: "string", description: "搜索关键词" },
      limit:       { type: "number", description: "期望返回数,默认 30", default: 30 },
      extendIfFew: { type: "number", description: "结果不足 limit/2 时追加抓取条数,默认 30", default: 30 },
    },
    required: ["query"],
  },
  metadata: { phase: ["searching", "planning"], timeout: 30_000 },

  async execute(input, ctx) {
    const limit = input.limit ?? 30;
    const extendIfFew = input.extendIfFew ?? 30;

    // L0: xhs-service 主源
    let notes = await callXhsService(input.query, limit);

    // 不够(少于 limit/2) → 渐进抓取,query 同义词扩展
    if (notes.length < limit / 2) {
      const expanded = expandQuery(input.query);
      const more = await Promise.all(
        expanded.slice(1, 3).map(q => callXhsService(q, Math.ceil(extendIfFew / 2)))
      );
      notes = dedupeByNoteId([...notes, ...more.flat()]);
    }

    if (!notes.length) {
      // L1: web_search "site:xiaohongshu.com {query}"
      notes = await webSearchFallback(input.query, limit);
    }

    // 全量存 state,top-10 给 LLM
    const ranked = rerankXhs(notes, ctx.state.preferences!);
    return {
      success: true, fallbackLevel: notes.length > 0 ? 0 : 1,
      data: { notes, top: ranked.slice(0, 10), total: notes.length },
    };
  },
};
```

**与现有 `search-xhs.ts` 的差异**:

| 维度 | 当前 | P0-B 改造后 |
|------|------|------------|
| 工具名 | `search_xhs_notes` | `search_xhs` |
| 默认 limit | 5(最大 10) | 30 |
| 渐进抓取 | 无 | 不够→同义词扩展→再抓 30 |
| 结果处理 | 全部返给 LLM | top-10 给 LLM,全量存 state |
| noteId 去重 | 无 | 有 |
| enrichTopNotes | 前 3 篇取详情 | 去掉(太慢) |

**降级链**:`xhs_service` → `web_search_site_filter` → `rag_travel_guides`

**写 state 字段**:`xhsNotes`(append, dedupe by noteId)

### 1.7 select_transport(新增)

```ts
// src/tools/definitions/select-transport.ts
export const selectTransportTool: RegisteredTool = {
  name: "select_transport",
  description: "用户选择去程和返程交通。LLM 调用此工具传递用户确认的选项。",
  input_schema: {
    type: "object",
    properties: {
      outboundId: { type: "string", description: "去程选项 id" },
      returnId:   { type: "string", description: "返程选项 id" },
    },
    required: ["outboundId", "returnId"],
  },
  metadata: { phase: ["selecting"], requiresUserInput: true, timeout: 5_000 },

  async execute(input, ctx) {
    const candidates = ctx.state.candidateTransports ?? [];
    const outbound = candidates.find(t => t.id === input.outboundId || t.trainNo === input.outboundId || t.flightNo === input.outboundId);
    const return_  = candidates.find(t => t.id === input.returnId || t.trainNo === input.returnId || t.flightNo === input.returnId);

    if (!outbound || !return_) {
      return { success: false, error: `未找到对应交通选项。outboundId=${input.outboundId} returnId=${input.returnId}。候选列表有 ${candidates.length} 个选项。` };
    }
    return { success: true, fallbackLevel: 0, data: { outbound, return: return_ } };
  },
};
```

**PRECONDITIONS**:`candidateTransports` 非空。

**写 state 字段**:`selectedOutbound` + `selectedReturn`

### 1.8 select_hotel(新增)

```ts
// src/tools/definitions/select-hotel.ts
export const selectHotelTool: RegisteredTool = {
  name: "select_hotel",
  description: "用户选择酒店。LLM 调用此工具传递用户确认的选项。",
  input_schema: {
    type: "object",
    properties: {
      hotelId: { type: "string", description: "酒店 id" },
    },
    required: ["hotelId"],
  },
  metadata: { phase: ["selecting"], requiresUserInput: true, timeout: 5_000 },

  async execute(input, ctx) {
    const candidates = ctx.state.candidateHotels ?? [];
    const hotel = candidates.find(h => h.id === input.hotelId || h.name === input.hotelId);
    if (!hotel) {
      return { success: false, error: `未找到对应酒店。hotelId=${input.hotelId},候选列表有 ${candidates.length} 家。` };
    }
    return { success: true, fallbackLevel: 0, data: { hotel } };
  },
};
```

**PRECONDITIONS**:`candidateHotels` 非空。

**写 state 字段**:`selectedHotel`

---

## 2. 共享 Schema 抽取

### 2.1 目录结构

```
src/tools/
├── schemas/                          # 新建
│   ├── index.ts                      # barrel: re-export all
│   ├── activity.ts                   # ActivitySchema(从 plan-schema.ts 迁)
│   ├── transit.ts                    # TransitSegmentSchema
│   ├── dining.ts                     # DiningPlanSchema
│   ├── itinerary.ts                  # ItinerarySlotSchema
│   ├── day-plan.ts                   # DayPlanSchema
│   ├── budget.ts                     # BudgetBreakdownSchema
│   ├── travel-plan.ts                # TravelPlanSchema
│   ├── hotel.ts                      # HotelSearchInputSchema + GeoConstraintSchema
│   ├── restaurant.ts                 # RestaurantSearchInputSchema
│   └── transport.ts                  # TransportOptionSchema
├── definitions/
│   ├── plan-schema.ts                # 保留 parsePlanLoose + simpleRepair(逻辑),import from ../schemas
│   └── ... 其他工具
├── policy.ts
├── registry.ts
└── types.ts
```

### 2.2 抽取原则

- `plan-schema.ts` 保留 `parsePlanLoose` + `simpleRepair` + `extractOutermostBlock`(逻辑函数)
- Zod schema 定义迁移到 `schemas/` 各文件,每个文件 export 一个 schema + derived type
- `definitions/` 中的工具从 `schemas/` import,不再从 `plan-schema.ts` import Zod 类型
- `plan-schema.ts` 从 `schemas/` re-export(向后兼容)

### 2.3 新增 schema 示例

```ts
// schemas/hotel.ts
import { z } from "zod";

export const GeoConstraintSchema = z.object({
  maxDistanceKm: z.number().positive().default(5),
  preferNear: z.enum(["transit", "center"]).optional(),
});

export const HotelSearchInputSchema = z.object({
  city: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().positive().default(1),
  maxPricePerNight: z.number().positive().optional(),
  maxStarRating: z.number().int().min(1).max(5).optional(),
  preferredArea: z.string().optional(),
  keyAttractions: z.array(z.string()).optional(),
  geoConstraint: GeoConstraintSchema.optional(),
  preferredBrands: z.array(z.string()).optional(),
});

export type GeoConstraint = z.infer<typeof GeoConstraintSchema>;
export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;
```

```ts
// schemas/restaurant.ts
import { z } from "zod";

export const RestaurantSearchInputSchema = z.object({
  city: z.string().min(1),
  scope: z.enum(["city", "attraction"]).default("city"),
  near: z.string().optional(),
  mealType: z.enum(["breakfast", "lunch", "dinner", "any"]).default("any"),
  preference: z.enum(["local_specialties", "trending", "mixed"]).default("local_specialties"),
  maxResults: z.number().int().positive().default(8),
});

export type RestaurantSearchInput = z.infer<typeof RestaurantSearchInputSchema>;
```

---

## 3. LLMPlanAgent 改造(兼容策略)

### 3.1 目标

LLMPlanAgent 从"内联 tool definitions + 内联 execute"切换为"从 ToolRegistry 获取 tools + registry.execute"。

### 3.2 改造步骤

**Step 1**:给 LLMPlanAgent 注入 ToolRegistry:
```ts
class LLMPlanAgent extends BaseAgent {
  constructor(log: Logger, dataSource: TravelDataSource, private toolRegistry?: ToolRegistry) {
    super(log, dataSource);
  }

  private buildToolDefs() {
    if (this.toolRegistry) {
      return this.toolRegistry.getToolDefs().filter(t =>
        ["search_attractions", "search_restaurants", "search_xhs", "search_weather", "search_travel_guides"]
          .includes(t.name)
      );
    }
    return [...旧的内联定义];  // 回退
  }

  private async executeTool(name: string, input: Record<string, unknown>, city: string, pref: UserPreferences) {
    if (this.toolRegistry) {
      const result = await this.toolRegistry.execute(name, input);
      return result.success ? result.data : { error: result.error };
    }
    return this.executeToolLegacy(name, input, city, pref);
  }
}
```

**Step 2**:TurnHandler 创建 LLMPlanAgent 时传入 registry:
```ts
const llmPlanAgent = new LLMPlanAgent(log, dataSource, toolRegistry);
```

**Step 3**:P0-C 时彻底删除 LLMPlanAgent 内联实现。

### 3.3 回退策略

- 如果 `toolRegistry` 为 undefined,全部回退到旧内联实现
- P0-B 期间保留旧代码,只在 `feat/p0-b-tools` 分支上切换
- P0-C 时彻底删除旧内联代码

---

## 4. 死代码清理

### 4.1 api/tools.ts

当前状态:定义 `TOOLS` 和 `executeTool`,但未被任何活路径调用。

P0-B 操作:**删除整个文件**。

```bash
grep -r "api/tools" nodejs/src/ --include="*.ts"
# 预期:0 结果
```

### 4.2 plan-travel.ts

当前状态:`createPlanTravelTool` 注册了 `plan_travel` 工具,内部调用旧 `TravelPlanningPipeline`。

P0-B 操作:**保留但标记 deprecated**。理由:
- `plan_travel` 不在 `policy.ts` 的 12 个标准工具列表中
- 被 `finalize_plan` 取代(Agent Loop 路径)
- 旧 `/api/plan` 路径可能还在用 → P0-C 删除旧 Pipeline 时一并删除

### 4.3 search_xhs_notes → search_xhs 重命名

影响范围:
- `tools/definitions/search-xhs.ts` 工具名 `search_xhs_notes` → `search_xhs`
- `tools/index.ts` 的 `createSearchXhsTool` import 更新
- `LLMPlanAgent.buildToolDefs()` 里 `search_xhs_notes` → `search_xhs`

### 4.4 清理范围总结

| 操作 | 文件 | 风险 |
|------|------|------|
| 删除 | `api/tools.ts` | 低(死代码) |
| 标记 deprecated | `plan-travel.ts` | 低(保留文件,加注释) |
| 重命名 | `search-xhs.ts`(工具名) | 中(需全局替换引用) |
| 改造 | `search-hotels.ts`(geoConstraint) | 低(向后兼容) |
| 改造 | `search-attractions.ts`(execute 签名对齐) | 低 |

---

## 5. 测试计划

### 5.1 每个工具单独测试

| 工具 | 测试文件 | 覆盖场景 |
|------|---------|---------|
| `search_baike` | `search-baike.test.ts` | 正常返回 / 空结果降级 / 超时 |
| `search_weather` | `search-weather.test.ts` | 正常天气 / API 不可用降级 |
| `search_restaurants` | `search-restaurants.test.ts` | scope=city / scope=attraction / near 无效 / 连锁过滤 / 本地特色<=60% / 缓存命中 |
| `search_travel_guides` | `search-travel-guides.test.ts` | RAG 命中 / 空结果 / RAG 不可用降级 |
| `search_hotels` | `search-hotels.test.ts` | 无 geoConstraint(旧) / geoConstraint 距离过滤 / preferNear 排序 / preferredBrands / preferredArea |
| `search_xhs` | `search-xhs.test.ts` | 正常 30 篇 / 不够→渐进抓取 / 全量存 state top-10 返 LLM / dedupe / xhs-service 不可用降级 |
| `select_transport` | `select-transport.test.ts` | 正常选择 / id 未找到 / candidates 为空 |
| `select_hotel` | `select-hotel.test.ts` | 正常选择 / id 未找到 / candidates 为空 |

### 5.2 集成测试

- 8 个工具全部注册到 ToolRegistry → LLMPlanAgent 用 registry 工具跑一次完整 planning
- 验证 LLMPlanAgent 走 registry 路径与旧内联路径输出一致

### 5.3 Schema 测试

- `schemas/*.test.ts`:每个 schema 的 Zod 校验 + 边界值 + 类型推导

---

## 6. P0-B 文件级 step plan

### Step 1:共享 Schema 抽取(纯重构)

文件:`tools/schemas/` 下 10 个文件(新建) + `plan-schema.ts`(改)
内容:§2.1 目录结构中所有 schema 文件 + `plan-schema.ts` 改为从 `schemas/` 导入 + `schemas/index.ts` barrel export

测试:已有 `plan-schema.test.ts` 迁移 + 扩展

Commit:`refactor(tools): extract shared schemas to tools/schemas/`

### Step 2:search_baike + search_weather + search_travel_guides(新工具)

文件:`tools/definitions/search-baike.ts`、`search-weather.ts`、`search-travel-guides.ts`(新建)
内容:§1.1 / §1.2 / §1.4 完整实现

测试:3 个工具单测

Commit:`feat(tools): search_baike + search_weather + search_travel_guides`

### Step 3:search_restaurants(两阶段)

文件:`tools/definitions/search-restaurants.ts`(新建)
内容:§1.3 完整实现(scope + 连锁过滤 + 本地特色 <=60%)

测试:search-restaurants.test.ts(8 case)

Commit:`feat(tools): search_restaurants with two-stage scope`

### Step 4:search_hotels geoConstraint + search_xhs 渐进抓取(改造)

文件:`tools/definitions/search-hotels.ts`(改)、`search-xhs.ts`(重写)
内容:§1.5 / §1.6

测试:改造后单测 + 向后兼容验证

Commit:`feat(tools): hotel geoConstraint + xhs progressive scraping`

### Step 5:select_transport + select_hotel(新工具)

文件:`tools/definitions/select-transport.ts`、`select-hotel.ts`(新建)
内容:§1.7 / §1.8

测试:2 个工具单测

Commit:`feat(tools): select_transport + select_hotel`

### Step 6:LLMPlanAgent → ToolRegistry

文件:`agents/llm-plan-agent.ts`(改)
内容:§3 改造方案

测试:集成测试(LLMPlanAgent + registry 完整 planning 流程)

Commit:`refactor(agents): LLMPlanAgent uses ToolRegistry instead of inline tools`

### Step 7:死代码清理 + 重命名 + index 更新

文件:
- `api/tools.ts`(删)
- `tools/definitions/plan-travel.ts`(标记 deprecated)
- `tools/definitions/search-xhs.ts`(工具名 `search_xhs_notes` → `search_xhs`)
- `tools/index.ts`(更新 import 列表,加新工具)

测试:全量回归(确保改造不破坏现有功能)

Commit:`refactor(tools): cleanup dead code + rename search_xhs`

**P0-B 总估时**:5-6 天(与 redesign §5 一致)

---

## 7. P0-B 启动检查清单

开工前确认:
- [ ] 本文档已 review
- [ ] `docs/agent-loop-redesign.md` §3.2 工具表已对照
- [ ] `src/tools/policy.ts` 的 12 个 `ToolName` 与本文档 8 个工具 + P0-A 已完成的 4 个工具一致
- [ ] xhs-service 可运行(`curl http://127.0.0.1:3220/xhs/health`)
- [ ] 高德 API key 有效 + QPS 限流 3/s 确认
- [ ] RAG 语料库已初始化(`RagSource` 可正常返回结果)
- [ ] WebSearch daemon 可运行
- [ ] git 主分支干净,新分支 `feat/p0-b-tools` 已建
- [ ] 测试框架 vitest 已配置

review 通过后,开 `feat/p0-b-tools` 分支,从 §6 Step 1 开始。

---

## 8. P0-A 已完成工具清单(无需改动)

这些工具在 P0-A 已完成,P0-B 不修改:

| 工具 | 文件 | 状态 |
|------|------|------|
| `collect_preferences` | `tools/definitions/collect-preferences.ts` | 正常 |
| `search_attractions` | `tools/definitions/search-attractions.ts` | 正常(不改,LLMPlanAgent 迁移到用此定义) |
| `plan_transit` | `tools/definitions/plan-transit.ts` | 正常(P0-A Step 7) |
| `finalize_plan` | `tools/definitions/finalize-plan.ts` | 正常(P0-A Step 7) |
| `search_trains` | `tools/definitions/search-trains.ts` | 正常(不改) |
| `search_flights` | `tools/definitions/search-flights.ts` | 正常(不改,但需确认与 candidateTransports 匹配) |
| `search_web` | `tools/definitions/search-web.ts` | 正常(不改,仅作为其他工具的降级源) |

表中所列 7 个工具 + 本文档 §1 的 8 个工具 = 15 个。`policy.ts` 声明了 12 个(`search_trains` 和 `search_flights` 不在其中),因为它们在 P0-A 设计中被合并为 `candidateTransports` 的填充来源,不作为独立 Agent Loop 工具暴露给 LLM。P0-B 不改变这个设计。

---

## 9. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §3.2 / §5 | P0-B 任务描述 |
| `docs/p0-a-contracts.md` | P0-A 契约(本文档参照格式) |
| `nodejs/src/tools/policy.ts` | 12 工具 phase gating + 降级链(权威源) |
| `nodejs/src/tools/definitions/plan-schema.ts` | Zod 行程 schema(将部分迁到 schemas/) |
| `nodejs/src/agents/llm-plan-agent.ts` | LLMPlanAgent 内联工具(§3 迁移目标) |
| `nodejs/src/api/tools.ts` | 死代码(§4.1 删除) |
