# P2-C 接口契约

> 关联:`docs/agent-loop-redesign.md` §4.7 / §5 P2-C / §8 验收标准 18
> 立项:2026-06-22
> 状态:**已完成** — Step 1+2 于 2026-06-23 落地,Step 3/4 留 P3+
> 目的:锁定降级链的可视化与监控接口——大部分已在 P0-A 落地,P2-C 补齐 trace-viewer fallback 展示 + `fallback-report.ts` 月度报表

---

## 0. 文档定位

redesign v2 §4.7 提出工具降级链表设计,P0-A 实施时**已经一并落地**:

- ✅ `TOOL_FALLBACK_CHAIN` 完整声明 14 工具(`policy.ts:102-117`)
- ✅ `ToolExecTraceEvent.fallbackLevel` 字段(`trace.ts:42`)
- ✅ `apply-tool-effects.ts` 的 `fallbackUsage[tool]++` 计数(`applyToolEffects` reducer 内)
- ✅ `callAmap` 的 `amapLimiter`(capacity=3, refill=3/s)+ trace 记 `amapWaitMs`

P2-C 的剩余工作集中在**让降级链可观测、可告警**:

- §1:已实现清单(对照 P0-A 实际代码,确认契约不漂移)
- §2:trace-viewer 展示规则(与 `p2-a-contracts.md` §3 互补)
- §3:`scripts/fallback-report.ts` 月度 fallback 报表
- §4:告警阈值 + 告警通道
- §5:待补齐的工具 fallback(可能的生产暴露)
- §6:测试计划
- §7:step plan(2-3 天)

**与 P2-A/P2-B 的关系**:
- P2-A 的 trace-viewer 负责**单 session 内**的 fallback 可视化
- P2-B 的 patterns.md 负责**跨 session** 的失败模式聚类
- P2-C 的 fallback-report 负责**跨 session 的 fallback 趋势** —— 不看行程质量,只看数据源健康度

---

## 1. 已实现清单(对照 P0-A 实际代码)

### 1.1 TOOL_FALLBACK_CHAIN(`src/tools/policy.ts:102-117`)

```ts
export const TOOL_FALLBACK_CHAIN: Record<ToolName, string[]> = {
  collect_preferences: [],
  search_baike:         ["baike_api", "web_search_baidu", "llm_generated"],
  search_attractions:   ["amap_poi", "web_search", "llm_generated"],
  search_restaurants:   ["amap_poi", "xhs_service", "web_search", "rag_travel_guides"],
  search_hotels:        ["booking_api", "amap_poi", "web_search"],
  search_xhs:           ["xhs_service", "web_search_site_filter", "rag_travel_guides"],
  search_weather:       ["amap_weather", "web_search"],
  search_travel_guides: ["rag_vector", "rag_keyword_fallback"],
  search_flights:       ["amadeus_api", "web_search"],
  search_trains:        ["train12306_mcp", "web_search"],
  plan_transit:         ["amap_direction", "haversine_estimate"],
  select_transport:     [],
  select_hotel:         [],
  finalize_plan:        [],
};
```

**索引约定**:
- index 0 = L0(主源)
- index 1 = L1(第一降级)
- index 2+ = L2/L3(深度降级)
- 空数组 `[]` = 无降级(纯逻辑工具,如 `select_*` / `finalize_plan` / `collect_preferences`)

**Trace `fallbackLevel` 字段**(`ToolExecTraceEvent.fallbackLevel`):
- 类型:`number`(不限制上限,因为某些工具可能有 4 级链)
- 含义:实际使用的 source 在 `TOOL_FALLBACK_CHAIN[tool]` 中的 index

### 1.2 fallbackUsage 计数(`AgentState.fallbackUsage`)

`src/runtime/state.ts:108`:
```ts
fallbackUsage: Record<string, number>;  // tool → 累计 L>0 调用次数
```

`src/runtime/apply-tool-effects.ts`(已有 reducer):
```ts
fallbackUsage: result.fallbackLevel > 0
  ? { ...next.fallbackUsage, [result.toolName]: (next.fallbackUsage[result.toolName] ?? 0) + 1 }
  : next.fallbackUsage,
```

**关键不变量**:
- `fallbackUsage` 只在 `fallbackLevel > 0` 时自增(L0 不算)
- 计数器跨 iter 累积,phase 切换不重置
- 每会话从 `{}` 开始,不持久化跨 session

### 1.3 Amap QPS 限流 + `amapWaitMs`(`src/tools/policy.ts:183-189`)

```ts
export const amapLimiter = new TokenBucket(3, 3);
export async function callAmap<T>(fn: () => Promise<T>): Promise<{ result: T; waitMs: number }> {
  const waitMs = await amapLimiter.acquire();
  const result = await fn();
  return { result, waitMs };
}
```

**Trace 字段**(`ToolExecTraceEvent.amapWaitMs`):
- 仅当工具内部用 `callAmap` 才有
- 记限流器累计等待毫秒数,0 表示无需等待
- `search_attractions` / `search_restaurants` / `search_hotels` / `plan_transit` 都有

### 1.4 已正确工作的场景

| 场景 | 实现位置 |
|------|---------|
| search_xhs 主源 xhs-service 挂 → 降级 web_search | `tools/definitions/search-xhs.ts`(P0-B 已实现) |
| search_baike web_search_baidu 不可达 → LLM 知识 | `tools/definitions/search-baike.ts`(P0-B) |
| amap POI 超 QPS → 排队等 | `policy.ts` amapLimiter |
| plan_transit 高德失败 → Haversine 估算 | `tools/definitions/plan-transit.ts`(P0-A) |

---

## 2. trace-viewer 展示规则(与 P2-A §3 互补)

### 2.1 单 tool_exec 事件的 fallback 标记

颜色映射(已在 `p2-a-contracts.md §3` 定义):

| Level | 颜色 | 场景 |
|-------|------|------|
| L0 | 绿 `#10b981` | 主源命中(健康) |
| L1 | 黄 `#f59e0b` | 主源失败,一级降级 |
| L2 | 红 `#ef4444` | 二级降级,数据质量打折 |
| L3+ | 深红 `#991b1b` | 链尾兜底(如 `rag_travel_guides`) |

**Tooltip 格式**:
```
L{level} = {source_name}
Primary: {chain[0]}
Tried: {chain[0..level-1].join(" → ")}
```

**示例**(search_xhs 走 L1):
```
L1 = web_search_site_filter
Primary: xhs_service
Tried: xhs_service
```

### 2.2 Session 顶部 fallback rate

在 TopBar 显示(已在 `p2-a-contracts.md §2.2` 定义):

```
Fallback rate: 13.3%   (8.7% 为黄色警告阈值)
```

阈值:
- `≤ 5%`: 绿色(默认主题色)
- `5%-30%`: 默认色
- `> 30%`: 黄色 + 图标 `⚠`(警告,可能主源不稳定)

### 2.3 按工具聚合的降级分布(折叠面板)

在右栏顶部加一个可折叠面板:

```html
<details class="fallback-summary">
  <summary>Fallback distribution (click to expand)</summary>
  <table>
    <thead>
      <tr><th>Tool</th><th>Calls</th><th>Fallbacks</th><th>Rate</th><th>By Level</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>search_xhs</td>
        <td>3</td>
        <td>1</td>
        <td class="warn">33.3%</td>
        <td>L0:2 L1:1</td>
      </tr>
      <tr>
        <td>search_attractions</td>
        <td>5</td>
        <td>0</td>
        <td class="ok">0%</td>
        <td>L0:5</td>
      </tr>
      ...
    </tbody>
  </table>
</details>
```

**渲染函数**(P2-A 实现 `trace-html-renderer.ts` 时一并落地):

```ts
function renderFallbackSummary(session: SessionTrace): string {
  const rows = Object.entries(session.stats.toolCallCount)
    .map(([tool, total]) => {
      const fb = session.stats.fallbackUsage[tool] ?? 0;
      const rate = total > 0 ? fb / total : 0;
      const cls = rate > 0.3 ? "warn" : rate === 0 ? "ok" : "";
      return `<tr>
        <td>${escapeHtml(tool)}</td>
        <td>${total}</td>
        <td>${fb}</td>
        <td class="${cls}">${(rate * 100).toFixed(1)}%</td>
        <td>${renderByLevel(session, tool)}</td>
      </tr>`;
    })
    .join("");
  return `<details class="fallback-summary">
    <summary>Fallback distribution</summary>
    <table>${rows}</table>
  </details>`;
}

function renderByLevel(session: SessionTrace, tool: string): string {
  const byLevel: Record<number, number> = {};
  for (const e of session.events) {
    if (e.type === "tool_exec" && e.tool === tool) {
      byLevel[e.fallbackLevel] = (byLevel[e.fallbackLevel] ?? 0) + 1;
    }
  }
  return Object.entries(byLevel)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, n]) => `L${level}:${n}`)
    .join(" ");
}
```

### 2.4 amapWaitMs 展示

tool_exec 的 `amapWaitMs > 0` 时,渲染在 duration 旁:

```
search_attractions  [1.2s] [+340ms wait]  [L0●]
```

`+340ms wait` 用灰色小字 + tooltip `amap limiter wait`。若 `amapWaitMs > 2000`,加 `⚠` 图标。

---

## 3. `scripts/fallback-report.ts` 月度报表

### 3.1 目标

扫描 `data/trace/*.jsonl`(全 session,不限评分),按工具聚合 fallback 次数,产出 `data/feedback/fallback-report-{YYYY-MM}.md`。

**与 patterns.md 的区别**:
- `patterns.md`(P2-B):看"行程质量差"的会话,按 failureCategory 聚类
- `fallback-report.md`(P2-C):看"数据源健康度",按工具聚合 fallback 趋势

### 3.2 CLI

```bash
# 本月报表
npx tsx scripts/fallback-report.ts --month current

# 指定月份
npx tsx scripts/fallback-report.ts --month 2026-06

# 指定 trace 目录
npx tsx scripts/fallback-report.ts --month current --trace-dir data/trace
```

### 3.3 输出格式

```markdown
# Fallback Report — 2026-06

> 自动生成:2026-06-30 23:59:00 UTC
> 扫描范围:data/trace/*.jsonl(共 48 个 session,2,143 次 tool_exec)

## 按工具聚合

| Tool | Total Calls | Fallback Count | Fallback Rate | By Level | Status |
|------|-------------|----------------|---------------|----------|--------|
| search_attractions | 245 | 3 | 1.2% | L0:242 L1:3 | ✅ healthy |
| search_xhs | 48 | 19 | 39.6% | L0:29 L1:15 L2:4 | ⚠ **degraded** |
| search_restaurants | 96 | 28 | 29.2% | L0:68 L1:22 L2:6 L3:0 | ⚠ watch |
| search_baike | 48 | 0 | 0% | L0:48 | ✅ healthy |
| plan_transit | 156 | 2 | 1.3% | L0:154 L1:2 | ✅ healthy |
| search_hotels | 48 | 4 | 8.3% | L0:44 L1:4 | ✅ acceptable |
| ... | ... | ... | ... | ... | ... |

## 全局统计

- 总 tool_exec:2,143
- 总 fallback:78(L1+:60 / L2+:10 / L3+:0)
- 全局 fallback rate:3.6%(健康)
- 主源不稳定工具数:1(search_xhs)

## 告警

### ⚠ search_xhs fallback rate 39.6%(> 30% 阈值)
**影响**:小红书内容覆盖率下降,行程餐厅推荐质量可能打折
**可能原因**:
1. xhs-service 进程异常(检查 `curl http://127.0.0.1:3220/xhs/health`)
2. xhs-service 被 XHS 反爬升级拦截(redesign §6.8 风险)
3. curl_cffi TLS 指纹过期

**建议 action**:
- 立即:`curl http://127.0.0.1:3220/xhs/health` 验证
- 24h 内:重启 xhs-service
- 1 周内:若持续高 fallback,触发 xhs-service 升级(curl_cffi 版本)

### ⚠ search_restaurants fallback rate 29.2%(接近阈值)
...
```

### 3.4 实现

```ts
// scripts/fallback-report.ts
interface ToolFallbackStats {
  tool: string;
  totalCalls: number;
  fallbackCount: number;       // L>0
  byLevel: Record<number, number>;
  fallbackRate: number;
  status: "healthy" | "acceptable" | "watch" | "degraded";
}

const ALERT_THRESHOLD = 0.30;   // 30% 标红
const WATCH_THRESHOLD = 0.20;   // 20% 关注

function classifyStatus(rate: number): ToolFallbackStats["status"] {
  if (rate === 0) return "healthy";
  if (rate < WATCH_THRESHOLD) return "acceptable";
  if (rate < ALERT_THRESHOLD) return "watch";
  return "degraded";
}

async function main() {
  const args = parseArgs(process.argv);
  const traceDir = args.traceDir ?? "data/trace";
  const files = listTraceFiles(traceDir, args.month);

  console.log(`[fallback-report] scanning ${files.length} trace files`);

  const statsByTool: Record<string, ToolFallbackStats> = {};

  for (const f of files) {
    const events = readTraceJsonl(f.path);
    for (const e of events) {
      if (e.type !== "tool_exec") continue;
      const stats = statsByTool[e.tool] ??= {
        tool: e.tool, totalCalls: 0, fallbackCount: 0,
        byLevel: {}, fallbackRate: 0, status: "healthy",
      };
      stats.totalCalls++;
      stats.byLevel[e.fallbackLevel] = (stats.byLevel[e.fallbackLevel] ?? 0) + 1;
      if (e.fallbackLevel > 0) stats.fallbackCount++;
    }
  }

  for (const s of Object.values(statsByTool)) {
    s.fallbackRate = s.totalCalls > 0 ? s.fallbackCount / s.totalCalls : 0;
    s.status = classifyStatus(s.fallbackRate);
  }

  const md = renderFallbackReport(args.month, statsByTool);
  const outPath = `data/feedback/fallback-report-${args.month}.md`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  console.log(`[OK] ${outPath}`);
}
```

### 3.5 触发节奏

- **每周一** 09:00 cron(与 review-feedback.ts 同批)
- commit message:`chore(observability): fallback report for {YYYY-MM}`

---

## 4. 告警阈值 + 告警通道

### 4.1 阈值表

| 指标 | 阈值 | 等级 | 动作 |
|------|------|------|------|
| 工具 fallback rate(单会话) | > 30% | warn | trace-viewer 黄色标记 |
| 工具 fallback rate(月度) | > 30% | degraded | fallback-report.md ⚠ 标记 |
| 工具 fallback rate(月度) | > 50% | critical | 报表红色 + 人工介入 |
| 全局 fallback rate(月度) | > 10% | warn | 报表顶部标注 |
| `amapWaitMs` 单次 | > 2,000ms | warn | trace-viewer `⚠` 图标 |
| `amapWaitMs` 月度均值 | > 500ms | degraded | 报表单独 section |

### 4.2 告警通道(P2-C 本身不实现)

当前**仅产 markdown 报表**,人工 review。自动化告警(Slack / 邮件)留到后续:

- **Slack webhook**:fallback-report.ts 加 `--notify-slack <webhook-url>` flag,degraded/critical 时 POST
- **邮件**:cron 脚本检测 critical 时 sendmail
- **Grafana**:把 trace 聚合到 Prometheus,可视化 fallback rate 时序

**P2-C 范围**:只做 markdown 报表 + 表格颜色标记。自动化通道留到 P3+。

### 4.3 告警抑制

为避免同一问题反复告警:
- 月度报表里,**同一工具连续 2 个月 degraded 才标 critical**
- 单月 degraded → 标 ⚠ 但不 critical
- 第二个月仍 degraded 且无 commit 修复 → 升级 critical

---

## 5. 待补齐的工具 fallback

对照 §1.1 的 `TOOL_FALLBACK_CHAIN`,以下工具的 fallback 实现**可能不完整**,需要 P2-C 实施时验证 + 补齐:

### 5.1 search_flights

**chain**:`["amadeus_api", "web_search"]`

**当前状态**(基于 P0-B 已实现):amadeus 失败时 fallback 到 web_search 已实现。

**潜在 gap**:
- amadeus API key 失效时是否立即降级?(目前可能抛错)
- web_search 解析的航班信息格式是否与 amadeus 一致?(价格 / 时刻)

**P2-C 动作**:跑一次 trace 模拟 amadeus 失败,确认 `fallbackLevel: 1` 写入正确。

### 5.2 search_trains

**chain**:`["train12306_mcp", "web_search"]`

**当前状态**:类似 search_flights。

**潜在 gap**:
- train12306 MCP 连接失败时,trace 是否记录失败原因?
- web_search 返回的车次格式是否含 `trainNo` / `departureTime`?

**P2-C 动作**:同上。

### 5.3 search_weather

**chain**:`["amap_weather", "web_search"]`

**当前状态**:P0-B 已实现。

**潜在 gap**:
- web_search 返回的天气文本如何结构化为 `WeatherSummary`?
- 若 L1 也失败,返回默认值还是抛错?(当前实现可能返回 `summary: "天气数据暂不可用"`)

**P2-C 动作**:验证降级路径的 fallbackLevel 标记。

### 5.4 其他

`search_baike` / `search_attractions` / `search_restaurants` / `search_xhs` / `plan_transit` 在 P0-B 已完整实现 fallback,P2-C 仅需 trace-viewer 展示。

---

## 6. 测试计划

### 6.1 fallback-report.ts 单测

| 测试 | 覆盖 |
|------|------|
| 空 trace 目录 | 友好提示 |
| 单 trace 文件 | 1 个工具的 stats |
| 多 trace 文件 | 聚合正确 |
| status 分级 | 0% / 5% / 25% / 35% 各对应 healthy/acceptable/watch/degraded |
| 告警阈值 | 30% 边界正确 |
| 月度过滤 | 只返指定月份的 trace |

### 6.2 trace-viewer fallback 展示单测

| 测试 | 覆盖 |
|------|------|
| L0 绿点 + tooltip | 显示 "Primary source (baike_api)" |
| L1 黄点 + tooltip | 显示 "Fallback L1 (web_search_baidu)" + "Tried: baike_api" |
| L2 红点 | 颜色正确 |
| session fallback rate | 0% / 8.7% / 35% 各对应绿/默认/黄 |
| 折叠面板 | 默认折叠,点击展开 |
| byLevel 渲染 | "L0:5 L1:2 L2:1" 格式 |

### 6.3 E2E smoke(留到 P2 末尾)

- 用真实会话产生 trace
- 跑 `npx tsx scripts/fallback-report.ts --month current`
- 人眼对照报表 vs trace-viewer 显示

---

## 7. P2-C step plan(2-3 天,2026-06-23 完成)

### Step 1:trace-viewer fallback 折叠面板(0.5 天) ✅
- 已在 P2-A trace-html-renderer.ts 实现: `toolByLevelStats` + `<details class="fallback-summary">`
- 快照测试已有 `fallback-recovery` fixture 覆盖

### Step 2:fallback-report.ts 脚本(1 天) ✅

- 扩展 `scripts/trace-html-renderer.ts` 加 `renderFallbackSummary`
- 扩展 `scripts/trace-aggregator.ts` 加 `byLevel` 统计(若 P2-A 未覆盖)
- 快照测试更新

Commit: `feat(scripts): fallback distribution panel in trace-viewer`

### Step 2:fallback-report.ts 脚本(1 天)

- `scripts/fallback-report.ts` 完整实现
- `scripts/__tests__/fallback-report.test.ts` 单测
- CLI 参数 + 月度过滤

Commit: `feat(scripts): monthly fallback report with status classification`

### Step 3:待补齐工具 fallback 验证(未做,数据源已有降级实现  )

- 跑 mock trace 模拟 search_flights / search_trains / search_weather 各级降级
- 对照 trace 输出的 `fallbackLevel` 与 `TOOL_FALLBACK_CHAIN` 索引
- 修复发现的 bug(若有)

Commit: `fix(tools): normalize fallback level reporting for flights/trains/weather`

### Step 4(可选):cron 配置 + Slack 通知(未做,P3+)

- 加 `crontab` 条目示例到 `docs/deployment.md`
- 可选 `--notify-slack <webhook>` flag 实现

Commit: `feat(observability): weekly cron + optional Slack notification`

---

## 8. 启动检查清单

- [ ] P2-A 已落地(trace-viewer 可用,§2 展示规则可在其上叠加)
- [ ] P0-B 已实现全部 8 工具(fallbackLevel 写入正确)
- [ ] `src/tools/policy.ts` 的 `TOOL_FALLBACK_CHAIN` 稳定(P0-A 锁定)
- [ ] 至少有 10+ 个真实 session 的 trace 数据(否则报表无意义)
- [ ] git 主分支干净,新分支 `feat/p2c-fallback-visibility` 已建

---

## 9. 与 P2-A / P2-B 的边界

| 职责 | 归属 |
|------|------|
| 单 tool_exec 的 fallback 颜色 + tooltip | **P2-A** `trace-html-renderer.ts` |
| Session 顶部 fallback rate 展示 | **P2-A** TopBar |
| 折叠面板"按工具聚合"展示 | **P2-C** Step 1(扩展 renderer) |
| 月度报表 markdown 产出 | **P2-C** `fallback-report.ts` |
| 跨会话失败模式聚类(按 failureCategory) | **P2-B** `review-feedback.ts` |
| 告警通道自动化(Slack / 邮件) | **不在 P2 范围**(P3+) |

**核心区分**:
- P2-A 负责"让单 session 的 fallback 可见"
- P2-B 负责"让行程质量差的 case 可统计"
- P2-C 负责"让数据源健康度可监控"

---

## 10. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §4.7 / §5 P2-C / §8 验收 18 | 降级链设计 + P2-C 任务 + 验收 |
| `docs/p0-a-contracts.md` §1.4 | applyToolEffects 的 fallbackUsage 实现 |
| `docs/p0-b-contracts.md` §1.1-1.6 | 各工具的 fallback chain 设计 |
| `docs/p2-a-contracts.md` §3 / §2.4 | trace-viewer 的 fallback_level 可视化(本文档补充 §2.3 折叠面板) |
| `docs/p2-b-contracts.md` §1.7 | patterns.md 与 fallback-report.md 共存于 data/feedback/ |
| `nodejs/src/tools/policy.ts:102-117` | TOOL_FALLBACK_CHAIN(降级链权威定义) |
| `nodejs/src/runtime/trace.ts:35-45` | ToolExecTraceEvent.fallbackLevel 字段 |
| `nodejs/src/runtime/apply-tool-effects.ts` | fallbackUsage 计数 reducer |
