# P1-A 接口契约

> 关联:`docs/agent-loop-redesign.md` §3.3 / §4.2 / §5 P1-A
> 立项:2026-06-18
> 状态:**Hard contract** — P1-A 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:锁定 JSON 鲁棒性提升的三层防御 + maxRetries LLM 自修复的实现细节

---

## 0. 文档定位

P0-A 的 `parsePlanLoose` 实现了两层防御(正则提取 + simpleRepair)。P1-A 升级为三层 + LLM 自修复:

- 第 1 道:brace-balanced 提取最外层 `{...}`
- 第 2 道:`jsonrepair` npm 包修复(尾逗号/缺括号/单引号/无引号 key)
- 第 3 道:Zod 校验(严格类型安全检查)
- LLM 自修复:三层都失败 → 错误回传 LLM → 最多重试 3 次

---

## 1. 三层防御实现

### 1.1 第 1 道:brace-balanced 提取(已有)

`extractOutermostBlock()` — 不依赖正则,处理嵌套 JSON,处理 markdown code fences。

### 1.2 第 2 道:jsonrepair(新增依赖)

```bash
npm i jsonrepair
# 单文件 ~5KB,零传递依赖
```

```ts
// src/tools/definitions/plan-schema.ts(改)
import { jsonrepair } from "jsonrepair";

function repairJson(raw: string): string {
  let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  try {
    return jsonrepair(cleaned);
  } catch {
    return simpleRepair(cleaned);  // 回退到旧 simpleRepair
  }
}
```

**jsonrepair 修复能力**:尾逗号 / 缺括号 / 单引号 / 无引号 key / 多余逗号。

### 1.3 第 3 道:Zod 校验(已有)

`TravelPlanSchema.parse(JSON.parse(repaired))` — 已在 `plan-schema.ts` 完整定义。

### 1.4 升级后的 parsePlanLoose

```ts
export function parsePlanLoose(raw: string): TravelPlan {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new JsonRepairExhaustedError("Empty input", raw?.slice(0, 200) ?? "");
  }

  const candidate = extractOutermostBlock(raw);
  if (!candidate) {
    throw new JsonRepairExhaustedError("No JSON object {...} found", raw.slice(0, 200));
  }

  let lastError: unknown;

  // 第 2 道:jsonrepair + JSON.parse + Zod
  try {
    const repaired = repairJson(candidate);
    return TravelPlanSchema.parse(JSON.parse(repaired));
  } catch (err) {
    lastError = err;
  }

  // 第 3 道(兜底):simpleRepair(保留)
  try {
    const repaired = simpleRepair(candidate);
    return TravelPlanSchema.parse(JSON.parse(repaired));
  } catch (err) {
    lastError = err;
  }

  throw new JsonRepairExhaustedError(
    "parsePlanLoose failed after extract + jsonrepair + simpleRepair",
    candidate.slice(-300),
    lastError,
  );
}
```

---

## 2. LLM 自修复循环(maxRetries=3)

### 2.1 集成点

自修复循环内嵌在 Agent Loop 的 `finalize_plan` 工具调用处:

```ts
let repairAttempts = 0;
while (repairAttempts < 3) {
  try {
    planResult = parsePlanLoose(rawJson);
    break;
  } catch (err) {
    repairAttempts++;
    if (repairAttempts >= 3) {
      throw new JsonRepairExhaustedError(`LLM 自修复耗尽(3 次)`, rawJson.slice(-300), err);
    }
    messages.push({
      role: "user",
      content: `JSON 解析失败(第 ${repairAttempts} 次):${err.message}

上次输出末尾:
${rawJson.slice(-300)}

请修正以上 JSON 错误后重新输出完整 JSON。
常见错误:尾逗号 / 缺括号 / 单引号代替双引号 / key 没有加引号。`,
    });
    const resp = await callLLM({ ... });
    rawJson = extractJsonFromResponse(resp);
  }
}
```

### 2.2 关键不变量

- 只有 `finalize_plan` 触发自修复,其他工具输出不经过此路径
- `budgetBreakdown.isWithinBudget === false` 且 `budgetRound < MAX` 不算修复失败(由 `applyFinalizePlan` 处理)
- repairAttempts 在成功时重置,每个 traverse loop 独立计数

### 2.3 trace 记录

```jsonl
{"ts":"...","iter":8,"type":"json_repair","attempt":1,"error":"Unexpected token ,","excerpt":"..."}
{"ts":"...","iter":9,"type":"json_repair_success","attempt":2,"strategy":"jsonrepair"}
```

---

## 3. 安装与配置

```bash
npm i jsonrepair
# package.json: "jsonrepair": "^3.x"
```

`tsconfig` 无需额外配置,jsonrepair 自带 `.d.ts`。单次调用 < 5ms(>10KB JSON)。

---

## 4. 测试计划

| 测试项 | 覆盖 |
|--------|------|
| jsonrepair 尾逗号 | `{"a":1,}` → pass |
| jsonrepair 缺括号 | `{"a":[1,2` → pass |
| jsonrepair 单引号 | `{'a':'hello'}` → pass |
| jsonrepair 无引号 key | `{a:1}` → pass |
| simpleRepair 兜底 | jsonrepair 失败时 simpleRepair 仍工作 |
| maxRetries=3 | 连续失败 3 次抛 JsonRepairExhaustedError |
| LLM self-repair | mock LLM 返回修正 JSON |
| 回归 | 现有 18 条 plan-schema.test.ts 全部通过 |

---

## 5. P1-A step plan

**Step 1**:安装 `jsonrepair` + 实现 `repairJson()` → commit:`feat(tools): add jsonrepair as second defense layer`

**Step 2**:Agent Loop 集成 LLM 自修复循环 → commit:`feat(runtime): LLM self-repair loop (maxRetries=3)`

**Step 3**:测试 + trace → commit:`test: jsonrepair + LLM self-repair unit tests`

**P1-A 总估时**:1 天

---

## 6. P1-A 启动检查清单

- [ ] `npm i jsonrepair` 成功,无 C 依赖
- [ ] `parsePlanLoose` 升级后所有现有测试通过
- [ ] `plan-schema.test.ts` 新增 jsonrepair 修复 case
- [ ] Agent Loop 的 `executeToolsParallel` 可嵌入 repair loop

---

## 7. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §4.2 | JSON 鲁棒设计 |
| `docs/p0-a-contracts.md` §2.2 / §3.2 | finalize_plan + PlanSchema |
| `nodejs/src/tools/definitions/plan-schema.ts` | parsePlanLoose 当前实现 |
| `nodejs/src/runtime/agent-loop.ts` | repair loop 集成点 |
