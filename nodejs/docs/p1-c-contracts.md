# P1-C 接口契约

> 关联:`docs/agent-loop-redesign.md` §3.2.1 / §4.3 / §5 P1-C / §8 验收标准 8-13
> 立项:2026-06-18
> 状态:**Hard contract** — P1-C 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:锁定行程质量提升的三大维度——时间线+交通、餐厅多样性、信息源融合

---

## 0. 文档定位

P1-C 在已有 Agent Loop + 工具系统之上提升行程输出质量:

1. **时间线 + 市内交通**:每天每个景点之间有 `plan_transit` 覆盖
2. **餐厅多样性**:本地特色 ≤60%,排除连锁(除非显式),景点间衔接餐饮
3. **信息源融合**:每个 Activity 标注来源,高德+XHS+RAG 三源交叉验证

---

## 1. 每日时间线 + 市内交通

### 1.1 时间线约束

每个 `DayPlan` 的 `morning / afternoon / evening` 三个 slot 之间必须有 `transitToNext`:

```ts
{
  dayIdx: 0,
  morning: {
    attractions: [浅草寺],
    transitToNext: { from:"浅草寺", to:"晴空塔", mode:"walking", durationMin:15 }
  },
  afternoon: {
    attractions: [晴空塔],
    transitToNext: { from:"晴空塔", to:"银座", mode:"transit", durationMin:20 }
  },
  evening: { attractions: [银座] }
  // 无 transitToNext → 当天最后一个 slot
}
```

### 1.2 plan_transit 覆盖率指标

```
coverage = 有 transitToNext 的 slot 数 / 总 slot 数(不含每天最后一个)
目标:100%
```

### 1.3 system prompt 强制

在 planning 阶段的 `PHASE_PROMPTS[planning]` 中加入:

```text
【时间线要求】
每个 DayPlan 的 morning/afternoon/evening 之间必须用 plan_transit 工具填充 transitToNext。
即使两点步行可达,也要调 plan_transit 获取准确步行时间。
每天最后一个 slot 不需要 transitToNext。
```

### 1.4 结果缓存

同一 `from→to` 组合缓存 TTL 5min,避免 planning 阶段重复打高德 API。

---

## 2. 餐厅多样性

### 2.1 规则定义

| 规则 | 实现层 | 强制程度 |
|------|--------|---------|
| 排除连锁品牌 | 工具实现层 | 硬过滤(除非用户显式要求) |
| 本地特色 ≤60% | rerank 阶段 | 软约束(出超降权非删除) |
| 每天 3 餐分配 | system prompt | 软约束 |
| 景点衔接餐饮 | `scope=attraction` | planning 阶段用 |

### 2.2 连锁品牌清单(可配置)

```ts
const CHAIN_BRANDS = new Set([
  "麦当劳", "肯德基", "星巴克", "海底捞",
  "必胜客", "汉堡王", "赛百味", "瑞幸咖啡", "蜜雪冰城",
]);
// settings.CHAIN_BRANDS_EXTRA 可扩展

// 如果用户有 preferredHotelBrands,跳过连锁过滤
if (prefs.preferredHotelBrands?.length) skipChainFilter = true;
```

### 2.3 本地特色比例控制

```ts
function enforceLocalDiversityCap(restaurants: Activity[], destination: string, maxRatio = 0.6): Activity[] {
  const localCap = Math.ceil(restaurants.length * maxRatio);
  let localCount = 0;
  return restaurants.filter(r => {
    if (isLocalSpecialty(r, destination)) return localCount++ < localCap;
    return true;
  });
}
```

### 2.4 餐厅分配到 dining slot

每个 `DayPlan.dining` 必须包含 3 个 slot:

```ts
dining: [
  { meal:"breakfast", restaurant:..., isLocalSpecialty:false },
  { meal:"lunch", restaurant:..., isLocalSpecialty:true },
  { meal:"dinner", restaurant:..., isLocalSpecialty:false },
]
```

无合适餐厅时只填 `alternatives`: `{ meal:"breakfast", alternatives:["酒店自助"], isLocalSpecialty:false }`

---

## 3. 信息源融合

### 3.1 三源权重

```ts
const SOURCE_WEIGHTS = {
  baike: 0.95,
  official_poi: 0.85,    // 高德
  hotel_provider: 0.80,  // Booking
  xhs: 0.70,
  web_search: 0.45,
  llm_generated: 0.30,
};
```

### 3.2 融合公式

```
finalScore = baseRelevance × SOURCE_WEIGHTS[source]
           + interestMatch × 0.25
           + specificityBoost × 0.10
           - redundancyPenalty
```

### 3.3 Activity.source 标注

每个 `Activity` 必须标注真实来源:

```ts
source: "amap" | "xhs" | "rag" | "baike" | "llm_generated"
```

`llm_generated` 仅当三源都找不到才允许,且 `rerankScore` ≤ 0.30。

### 3.4 融合实现位置

- **工具层**:高德结果 + XHS 结果去重合并(name 匹配)
- **LLM 层**:RAG 融合 — LLM 根据攻略文本额外推荐,标记 `source="rag"`

---

## 4. 行程质量自检清单

`finalize_plan` 调用前,LLM 自检:

```text
1. □ 每天 morning→afternoon→evening 之间都有 transitToNext?
2. □ 每天 dining 数组长度为 3?
3. □ 餐厅来源标注了 source?
4. □ 没有连锁品牌?
5. □ 本地特色不超过 60%?
6. □ 每日总耗时 ≤ 14h?
7. □ 预算 breakdown 与活动 cost 总和一致?
8. □ 景点顺序地理合理?
```

---

## 5. 测试计划

| 测试项 | 覆盖 |
|--------|------|
| transit coverage 计算 | transitToNext >= slot-1 |
| 连锁品牌过滤 | 过滤正确 |
| 本地特色 cap | 10 家最多 6 家本地 |
| 多源融合分数 | weighted score 公式正确 |
| Activity.source 标注 | 100% 有 source |
| E2E | 完整 planning → finalize 通过所有自检 |

---

## 6. P1-C step plan

1. 时间线强制 — PHASE_PROMPTS + transit coverage 校验 → commit:`feat(runtime): enforce daily timeline transit coverage`
2. 餐厅多样性 — 连锁过滤升级 + 本地特色 cap → commit:`feat(tools): restaurant diversity enforcement`
3. 信息源融合 — source 强制 + 三源 weight 公式 → commit:`feat(tools): multi-source fusion with weighted scoring`
4. 自检清单 — system prompt 注入 self-check → commit:`feat(runtime): planning self-check checklist`
5. 测试 + E2E → commit:`test: P1-C quality enforcement tests`

**P1-C 总估时**:4-5 天

---

## 7. P1-C 启动检查清单

- [ ] P0-A/B/C 全部完成,Agent Loop 可产出完整 `TravelPlan`
- [ ] `search_restaurants` scope=attraction 通路可用
- [ ] `plan_transit` 工具可用
- [ ] XHS + RAG 服务正常运行
- [ ] 高德 API key 有效 + QPS 限流工作

---

## 8. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §3.2.1 / §4.3 / §8 | 餐厅策略 + rerank + 验收标准 |
| `docs/p0-a-contracts.md` §2.1 / §3 | plan_transit + TravelPlanSchema |
| `docs/p0-b-contracts.md` §1.3/1.4/1.6 | search_restaurants/search_travel_guides/search_xhs |
| `nodejs/src/tools/definitions/search-restaurants.ts` | 餐厅搜索工具 |
| `nodejs/src/runtime/system-prompt.ts` | planning prompt(改造目标) |
