# P2-A 接口契约

> 关联:`docs/agent-loop-redesign.md` §4.5 / §4.6 / §5 P2-A / §8 验收标准(trace 相关)
> 立项:2026-06-22
> 状态:**Hard contract** — P2-A 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:锁定 trace-viewer 的三栏 HTML 结构、jsonl 聚合契约、CLI 接口、mock fixtures 规格,让"复现一次会话"变成打开一个 HTML 文件的事

---

## 0. 文档定位

P0-A 完成时,`src/runtime/trace.ts` 已能写 7 种事件类型到 `data/trace/{sid}.jsonl`(`trace.ts:5-91`),`TOOL_FALLBACK_CHAIN` 与 `fallbackLevel` 也已在 `policy.ts:102-117` + `apply-tool-effects.ts` 落地。**但 `data/trace/` 目录至今为空**——没有可观测性 UI,人工复盘只能 `cat` jsonl,导致:

1. P0-A 完成后,无法用真实 trace 数据反向校验 loop 正确性
2. P2-B(数据飞轮)的"人工标注失败模式"缺乏入口
3. fallback 降级链是否在生产中触发,无从观察

P2-A 就是要把 trace jsonl 变成**可浏览、可诊断**的三栏 HTML,作为整个 P2 闭环的起点。**不依赖真实 trace 数据**——用 mock fixtures 解耦开发与运行时。

**本文档定义**:
- §1:trace jsonl 读取 + 聚合契约(纯函数,无副作用)
- §2:三栏 HTML 渲染规则(纯函数 → string)
- §3:fallback_level 可视化(与 P2-C 交集,cross-ref `p2-c-contracts.md` §2)
- §4:`scripts/trace-viewer.ts` CLI 接口
- §5:mock fixtures 规格(4 个场景覆盖)
- §6:单文件 HTML 约束 + 体积上限
- §7:测试计划 + 快照策略
- §8:step plan(4-5 天)
- §9:启动检查清单

---

## 1. trace jsonl 读取 + 聚合契约

### 1.1 文件路径规则

```
data/trace/{sid}.jsonl       — 单 session 一个文件
data/trace-viewer/{sid}.html — 渲染输出
scripts/_trace-fixtures/*.jsonl — mock fixtures(测试 + UI 开发)
```

**列出所有 session**(给 `--all` 用):
```ts
// scripts/trace-aggregator.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function listSessions(traceDir = "data/trace"): Array<{ sid: string; mtimeMs: number }> {
  try {
    return readdirSync(traceDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({
        sid: f.replace(/\.jsonl$/, ""),
        mtimeMs: statSync(join(traceDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);  // 最新在前
  } catch {
    return [];  // 目录不存在 → 空列表
  }
}
```

**`--latest` 的定义**:按 `mtimeMs` 倒序第一。

### 1.2 事件类型 typeguard(复用,不重定义)

**直接 import**,不重复声明:

```ts
// scripts/trace-aggregator.ts
import type {
  TraceEvent,
  LlmRequestTraceEvent,
  LlmResponseTraceEvent,
  ToolExecTraceEvent,
  StateChangeTraceEvent,
  PhaseChangeTraceEvent,
  ErrorTraceEvent,
  HeartbeatTraceEvent,
} from "../src/runtime/trace.js";
```

**未知事件容错**:未来新增事件类型时 viewer 不应崩。加一个 `UnknownTraceEvent` 兜底:

```ts
interface UnknownTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: string;  // 原始 type 字段
  [key: string]: unknown;
}

function isKnownEvent(e: unknown): e is TraceEvent {
  if (!e || typeof e !== "object") return false;
  const type = (e as { type?: unknown }).type;
  return [
    "llm_request", "llm_response", "tool_exec",
    "state_change", "phase_change", "heartbeat", "error",
  ].includes(type as string);
}
```

### 1.3 jsonl 读取(按行 parse)

```ts
export function readTraceJsonl(filePath: string): TraceEvent[] {
  const raw = readFileSync(filePath, "utf8");
  const events: TraceEvent[] = [];
  const lines = raw.split("\n");
  const malformed: Array<{ lineNo: number; excerpt: string }> = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (isKnownEvent(parsed)) {
        events.push(parsed);
      } else {
        malformed.push({ lineNo: idx + 1, excerpt: trimmed.slice(0, 80) });
      }
    } catch (err) {
      malformed.push({ lineNo: idx + 1, excerpt: trimmed.slice(0, 80) });
    }
  });

  if (malformed.length > 0) {
    console.warn(`[trace-aggregator] ${malformed.length} malformed lines in ${filePath}`);
    console.warn(`  first: line ${malformed[0].lineNo}: ${malformed[0].excerpt}`);
  }
  return events;
}
```

**关键约束**:
- 单条事件解析失败不影响其他事件(容错)
- malformed 行数 + 首行摘要在 stderr 警告(不抛错)
- 空文件 → 返回 `[]`,不算错误

### 1.4 iter 聚合规则

同一 `iter` 编号的事件归到一张 IterCard。**iter 跨 phase**:phase 切换后 iter 不重置。

```ts
export interface IterCard {
  iter: number;
  phase: Phase;                        // 该 iter 开始时的 phase(取最近一次 phase_change 之前的 phase)
  llmRequest?: LlmRequestTraceEvent;
  llmResponse?: LlmResponseTraceEvent;
  toolExecs: ToolExecTraceEvent[];     // 按 ts 排序
  stateChanges: StateChangeTraceEvent[];
  errors: ErrorTraceEvent[];
  heartbeats: HeartbeatTraceEvent[];
  unknownEvents: UnknownTraceEvent[];  // 未知类型,保留供调试
}

export function aggregateByIter(events: TraceEvent[]): IterCard[] {
  const byIter = new Map<number, IterCard>();
  let currentPhase: Phase = "gathering";

  for (const e of events) {
    const card = byIter.get(e.iter) ?? {
      iter: e.iter, phase: currentPhase,
      toolExecs: [], stateChanges: [], errors: [], heartbeats: [], unknownEvents: [],
    };

    switch (e.type) {
      case "llm_request":  card.llmRequest = e; break;
      case "llm_response": card.llmResponse = e; break;
      case "tool_exec":    card.toolExecs.push(e); break;
      case "state_change": card.stateChanges.push(e); break;
      case "phase_change": card.phase = e.from; currentPhase = e.to; break;  // 本 iter 显示旧 phase
      case "heartbeat":    card.heartbeats.push(e); break;
      case "error":        card.errors.push(e); break;
      default:             card.unknownEvents.push(e as UnknownTraceEvent);
    }

    byIter.set(e.iter, card);
  }

  return Array.from(byIter.values()).sort((a, b) => a.iter - b.iter);
}
```

**关键不变量**:
- `phase_change` 事件归属"原 iter",该 iter 的 IterCard.phase = `e.from`(下一 iter 才显示新 phase)
- `tool_execs` 按 `ts` 排序(不依赖 jsonl 行序)
- `iter` 编号必须非负整数;若 jsonl 里 iter 缺失,丢弃到 `unknownEvents`

### 1.5 phase 时间轴聚合

```ts
export interface PhaseSegment {
  phase: Phase;
  startIter: number;
  endIter: number;    // inclusive
  iterCount: number;
  reason?: string;    // 来自 phase_change.reason
}

export function buildPhaseTimeline(events: TraceEvent[]): PhaseSegment[] {
  const phaseChanges = events.filter(e => e.type === "phase_change") as PhaseChangeTraceEvent[];
  if (phaseChanges.length === 0) {
    const maxIter = Math.max(0, ...events.map(e => e.iter));
    return [{ phase: "gathering", startIter: 0, endIter: maxIter, iterCount: maxIter + 1 }];
  }

  const segments: PhaseSegment[] = [];
  let prev = { phase: phaseChanges[0].from, iter: 0, reason: undefined };

  for (const pc of phaseChanges) {
    segments.push({
      phase: prev.phase,
      startIter: prev.iter,
      endIter: pc.iter,
      iterCount: pc.iter - prev.iter + 1,
      reason: pc.reason,
    });
    prev = { phase: pc.to, iter: pc.iter + 1, reason: pc.reason };
  }

  const lastIter = Math.max(0, ...events.map(e => e.iter));
  if (prev.iter <= lastIter) {
    segments.push({
      phase: prev.phase,
      startIter: prev.iter,
      endIter: lastIter,
      iterCount: lastIter - prev.iter + 1,
    });
  }

  return segments;
}
```

### 1.6 SessionTrace + stats

```ts
export interface SessionTrace {
  sid: string;
  events: TraceEvent[];
  iterCards: IterCard[];
  phaseTimeline: PhaseSegment[];
  stats: {
    totalIters: number;
    totalEvents: number;
    phaseDistribution: Record<Phase, number>;   // 每个 phase 的 iter 数
    toolCallCount: Record<string, number>;       // 工具 → 总调用次数
    fallbackUsage: Record<string, number>;       // 工具 → L>0 调用次数(降级次数)
    fallbackRate: number;                        // 总降级次数 / 总调用次数
    errorCount: number;
    durationMs: number;                          // 首末事件 ts 差
  };
}

export function buildSessionTrace(sid: string, events: TraceEvent[]): SessionTrace {
  const iterCards = aggregateByIter(events);
  const phaseTimeline = buildPhaseTimeline(events);

  const toolCallCount: Record<string, number> = {};
  const fallbackUsage: Record<string, number> = {};
  let fallbackTotal = 0;
  let callsTotal = 0;
  let errorCount = 0;

  for (const e of events) {
    if (e.type === "tool_exec") {
      toolCallCount[e.tool] = (toolCallCount[e.tool] ?? 0) + 1;
      callsTotal++;
      if (e.fallbackLevel > 0) {
        fallbackUsage[e.tool] = (fallbackUsage[e.tool] ?? 0) + 1;
        fallbackTotal++;
      }
    } else if (e.type === "error") {
      errorCount++;
    }
  }

  const phaseDistribution: Record<Phase, number> = {
    gathering: 0, searching: 0, selecting: 0, planning: 0, completed: 0,
  };
  for (const seg of phaseTimeline) {
    phaseDistribution[seg.phase] += seg.iterCount;
  }

  const timestamps = events.map(e => Date.parse(e.ts)).filter(t => !Number.isNaN(t));
  const durationMs = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;

  return {
    sid,
    events,
    iterCards,
    phaseTimeline,
    stats: {
      totalIters: iterCards.length,
      totalEvents: events.length,
      phaseDistribution,
      toolCallCount,
      fallbackUsage,
      fallbackRate: callsTotal > 0 ? fallbackTotal / callsTotal : 0,
      errorCount,
      durationMs,
    },
  };
}
```

---

## 2. 三栏 HTML 渲染

### 2.1 整体结构(纯函数,输出 string)

```ts
// scripts/trace-html-renderer.ts
export function renderHtml(session: SessionTrace): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>...</head>
<body>
  ${renderTopBar(session)}
  <div class="layout">
    ${renderLeftPane(session)}      <!-- iter 列表 -->
    ${renderCenterPane(session)}    <!-- 当前 iter 详情 -->
    ${renderRightPane(session)}     <!-- state diff -->
  </div>
  <script>${EMBEDDED_JS}</script>
</body>
</html>`;
}
```

### 2.2 顶部条(TopBar)

显示 session 元数据,单行:

```
Session: abc123  |  Iters: 12  |  Duration: 47s  |  Tool calls: 23  |  Fallback rate: 8.7%  |  Errors: 0
Phase timeline: gathering(2) → searching(4) → selecting(2) → planning(3) → completed(1)
```

实现:
```ts
function renderTopBar(session: SessionTrace): string {
  const tl = session.phaseTimeline
    .map(seg => `${seg.phase}(${seg.iterCount})`)
    .join(" → ");
  return `<header class="top-bar">
    <div class="meta">
      <span class="sid">Session: ${escapeHtml(session.sid)}</span>
      <span>Iters: ${session.stats.totalIters}</span>
      <span>Duration: ${(session.stats.durationMs / 1000).toFixed(1)}s</span>
      <span>Tool calls: ${sumValues(session.stats.toolCallCount)}</span>
      <span class="${session.stats.fallbackRate > 0.3 ? "warn" : ""}">
        Fallback rate: ${(session.stats.fallbackRate * 100).toFixed(1)}%
      </span>
      <span class="${session.stats.errorCount > 0 ? "err" : ""}">Errors: ${session.stats.errorCount}</span>
    </div>
    <div class="timeline">${escapeHtml(tl)}</div>
  </header>`;
}
```

### 2.3 左栏(Iter 列表 + Phase 分组)

- 默认折叠 phase 分组,展开后显示 iter 行
- 当前选中 iter 高亮(`.selected` class)
- 点击触发 `selectIter(idx)` JS 函数,更新中栏 + 右栏

```html
<aside class="left-pane">
  <div class="phase-group" data-phase="gathering">
    <div class="phase-header">gathering (2 iters)</div>
    <ul>
      <li class="iter-item selected" data-iter="0">▶ iter 0</li>
      <li class="iter-item" data-iter="1">iter 1</li>
    </ul>
  </div>
  ...
</aside>
```

**Iter 行标记**:
- 包含 errors 的 iter 加红点
- 包含 fallback 的 iter 加黄点
- 正常 iter 无标记

### 2.4 中栏(Iter 详情)

三块从上到下:**Thought** → **Tool calls** → **Errors**(可选)。

```html
<main class="center-pane">
  <section class="thought">
    <h3>Thought</h3>
    <blockquote>{thought text}</blockquote>
  </section>

  <section class="tool-calls">
    <h3>Tool calls (${toolExecs.length})</h3>
    <ul>
      <li class="tool-call">
        <div class="tool-header">
          <span class="tool-name">search_baike</span>
          <span class="duration">325ms</span>
          <span class="fallback-badge" data-level="0" title="Primary source (baike_api)">L0●</span>
        </div>
        <details class="result">
          <summary>Result (200 chars)</summary>
          <pre>{truncated result}</pre>
        </details>
      </li>
      ...
    </ul>
  </section>

  <section class="errors" hidden>
    <h3>Errors</h3>
    <pre>{error text}</pre>
  </section>
</main>
```

**Tool call 渲染**:
```ts
function renderToolCall(te: ToolExecTraceEvent): string {
  const level = te.fallbackLevel;
  const sourceName = TOOL_FALLBACK_CHAIN[te.tool]?.[level] ?? "unknown";
  const levelClass = level === 0 ? "ok" : level === 1 ? "warn" : "err";
  const summary = formatResultSummary(te.resultSummary, 200);

  return `<li class="tool-call">
    <div class="tool-header">
      <span class="tool-name">${escapeHtml(te.tool)}</span>
      <span class="duration">${te.durationMs}ms</span>
      <span class="fallback-badge ${levelClass}" title="L${level} = ${escapeHtml(sourceName)}">L${level}●</span>
      ${te.amapWaitMs ? `<span class="amap-wait" title="amap limiter wait">+${te.amapWaitMs}ms</span>` : ""}
    </div>
    <details class="result">
      <summary>Result</summary>
      <pre>${escapeHtml(summary)}</pre>
    </details>
  </li>`;
}

function formatResultSummary(summary: unknown, maxLen: number): string {
  if (!summary) return "(no summary)";
  const json = JSON.stringify(summary, null, 2);
  return json.length > maxLen ? json.slice(0, maxLen) + "\n... (truncated)" : json;
}
```

### 2.5 右栏(State diff)

显示**当前选中 iter** 的 `state_change` 事件:

```html
<aside class="right-pane">
  <h3>State diff (iter ${idx})</h3>
  <ul class="state-diff">
    <li class="op-set">
      <span class="field">preferences.destination</span>
      <span class="value">东京</span>
    </li>
    <li class="op-append">
      <span class="field">candidateAttractions</span>
      <span class="value">+ 浅草寺, 明治神宫</span>
    </li>
    ...
  </ul>
  <div class="empty-state" hidden>No state changes in this iter.</div>
</aside>
```

**StateChange 渲染**:
```ts
function renderStateChange(sc: StateChangeTraceEvent): string {
  const valueSummary = formatValueSummary(sc.valueSummary);
  const opClass = `op-${sc.op}`;
  return `<li class="${opClass}">
    <span class="field">${escapeHtml(sc.field)}</span>
    <span class="op">${sc.op}</span>
    <span class="value">${escapeHtml(valueSummary)}</span>
  </li>`;
}

function formatValueSummary(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 60) + "..." : v;
  if (Array.isArray(v)) return `+ ${v.length} item(s)`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    return `{ ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""} }`;
  }
  return String(v);
}
```

### 2.6 内嵌 JS(切换 iter 交互)

```ts
const EMBEDDED_JS = `
const iterCards = ${JSON.stringify(session.iterCards.map(card => ({
  iter: card.iter,
  stateChanges: card.stateChanges,
})))};

function selectIter(idx) {
  document.querySelectorAll('.iter-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.iter) === idx);
  });
  // 更新中栏 + 右栏(通过预渲染的所有 iter 数据,或 sessionStorage)
  renderCenterPane(idx);
  renderRightPane(idx);
}

document.querySelectorAll('.iter-item').forEach(el => {
  el.addEventListener('click', () => selectIter(parseInt(el.dataset.iter)));
});
`;
```

**优化**:为避免 HTML 体积爆炸(每次 iter 都预渲染中栏 DOM),用 `<template id="iter-{idx}">` 存所有 iter 的数据,切换时用 JS 替换 `innerHTML`。

---

## 3. fallback_level 可视化(与 P2-C 交集)

| Level | 颜色 | 含义 | tooltip |
|-------|------|------|---------|
| L0 | 绿(`#10b981`) | 主源命中 | `Primary source (baike_api)` |
| L1 | 黄(`#f59e0b`) | 第一降级 | `Fallback L1 (web_search_baidu)` |
| L2 | 红(`#ef4444`) | 第二降级 | `Fallback L2 (llm_generated)` |
| L3+ | 深红(`#991b1b`) | 链尾兜底 | `Fallback L{N} (rag_travel_guides)` |

**source 名查询**:
```ts
import { TOOL_FALLBACK_CHAIN } from "../src/tools/policy.js";

function fallbackSourceName(tool: string, level: number): string {
  const chain = TOOL_FALLBACK_CHAIN[tool as keyof typeof TOOL_FALLBACK_CHAIN];
  if (!chain || chain.length === 0) return "no-fallback-defined";
  return chain[level] ?? `beyond-chain (${level})`;
}
```

**session 顶部 fallback rate**:
- `≤ 5%`: 绿色(正常)
- `5%-30%`: 默认色
- `> 30%`: 黄色警告(前端 P2-C 详述,此处仅展示)

---

## 4. CLI 接口

### 4.1 命令

```bash
# 渲染最近一个 session(按 mtime 排序)
npx tsx scripts/trace-viewer.ts --latest

# 渲染指定 session
npx tsx scripts/trace-viewer.ts --sid abc123

# 渲染全部(批量)
npx tsx scripts/trace-viewer.ts --all

# 开发模式:文件变更自动重渲染
npx tsx scripts/trace-viewer.ts --sid abc123 --watch

# 自动打开浏览器(macOS / Windows / Linux)
npx tsx scripts/trace-viewer.ts --latest --open

# 自定义 trace 目录(测试用)
npx tsx scripts/trace-viewer.ts --latest --trace-dir scripts/_trace-fixtures
```

### 4.2 参数表

| Flag | 类型 | 默认 | 说明 |
|------|------|------|------|
| `--sid <id>` | string | — | 指定 session id(与 `--latest`/`--all` 互斥) |
| `--latest` | bool | false | 渲染最近一个 session |
| `--all` | bool | false | 渲染全部 |
| `--watch` | bool | false | 文件变更自动重渲染(仅配合 `--sid`) |
| `--open` | bool | false | 渲染完打开浏览器 |
| `--trace-dir <path>` | string | `data/trace` | trace 目录(测试覆盖) |
| `--out-dir <path>` | string | `data/trace-viewer` | 输出目录 |

### 4.3 实现要点

```ts
// scripts/trace-viewer.ts
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { traceDir: "data/trace", outDir: "data/trace-viewer" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sid") args.sid = argv[++i];
    else if (a === "--latest") args.latest = true;
    else if (a === "--all") args.all = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--open") args.open = true;
    else if (a === "--trace-dir") args.traceDir = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }

  const selectors = [args.sid, args.latest, args.all].filter(Boolean).length;
  if (selectors === 0) { printHelp(); process.exit(1); }
  if (selectors > 1) throw new Error("--sid / --latest / --all 互斥");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const sessions = listSessions(args.traceDir);

  if (sessions.length === 0) {
    console.warn(`[trace-viewer] No sessions in ${args.traceDir}.`);
    console.warn(`  Run a conversation first to produce data/trace/{sid}.jsonl.`);
    console.warn(`  Or use --trace-dir scripts/_trace-fixtures to preview with mock data.`);
    process.exit(0);
  }

  const targets = args.all ? sessions
    : args.latest ? [sessions[0]]
    : sessions.filter(s => s.sid === args.sid);

  if (targets.length === 0) {
    console.error(`[trace-viewer] sid "${args.sid}" not found.`);
    process.exit(1);
  }

  mkdirSync(args.outDir, { recursive: true });

  for (const s of targets) {
    const events = readTraceJsonl(join(args.traceDir, `${s.sid}.jsonl`));
    const session = buildSessionTrace(s.sid, events);
    const html = renderHtml(session);
    const outPath = join(args.outDir, `${s.sid}.html`);
    writeFileSync(outPath, html, "utf8");
    console.log(`[OK] ${outPath}  (${(html.length / 1024).toFixed(1)}KB, ${session.stats.totalIters} iters)`);

    if (args.open && targets.length === 1) openInBrowser(outPath);
  }

  if (args.watch && args.sid) {
    watchFile(join(args.traceDir, `${args.sid}.jsonl`), () => main().catch(console.error));
  }
}
```

### 4.4 `--watch` 行为约束

- 只在 `--sid` 模式下生效(`--all` + `--watch` 组合禁止,因为开太多 watcher)
- `fs.watch` 在 Windows 上 debounce 500ms(避免编辑器保存触发多次)
- 重新渲染时只覆盖该 sid 的 HTML,不影响其他

---

## 5. Mock fixtures 规格

**位置**:`scripts/_trace-fixtures/*.jsonl`(4 个文件)

### 5.1 `happy-path.jsonl`

模拟一次"东京 5 天 预算 1.5 万"完整会话:
- 12 个 iter:gathering(2) → searching(4) → selecting(2) → planning(3) → completed(1)
- 全部 tool_exec 的 `fallbackLevel: 0`
- 包含所有 7 种事件类型
- 包含 phase_change × 4
- `thought` 字段非空且合理

**用途**:验证 viewer 全流程渲染、stats 统计正确。

### 5.2 `fallback-recovery.jsonl`

- iter 3 的 `search_xhs` 工具:`fallbackLevel: 1`(`web_search_site_filter` 降级)
- iter 5 的 `search_restaurants(scope=city)`:`fallbackLevel: 2`(`web_search` 降级)
- 最终 phase 仍到 completed
- fallback rate ≈ 2/15 = 13.3%

**用途**:验证 fallback_level 颜色、tooltip、顶部 fallback rate 计算。

### 5.3 `json-repair.jsonl`

- iter 9 / 10 / 11 三次 `finalize_plan` 调用
- 每次都附加 `error` 事件(JSON parse failed)
- iter 12 第四次成功
- 包含多次 `state_change` 写入 `_pendingBudgetFeedback`(预算超限回退)
- `budgetRound` 从 0 → 1 → 2 → 3

**用途**:验证错误展示、retry 流程可视化、budgetRound 计数。

### 5.4 `phase-stuck.jsonl`

- iter 4 / 5 / 6 连续三次 `search_attractions` 被 reject(phase 不匹配)
- iter 7 触发 `force_finish`
- 总 iter 数 ≤ 8,phase 卡在 searching

**用途**:验证 rejection 显示、phase 卡死告警。

### 5.5 Fixtures 生成策略

**不手写 jsonl**,用 TS 脚本生成:

```ts
// scripts/_trace-fixtures/_generator.ts
function buildHappyPath(): TraceEvent[] {
  const sid = "happy-path";
  const events: TraceEvent[] = [];
  const ts0 = Date.parse("2026-06-22T10:00:00Z");
  let ts = ts0;

  const push = (iter: number, e: Partial<TraceEvent> & { type: string }) => {
    events.push({ ts: new Date(ts++).toISOString(), sid, iter, ...e } as TraceEvent);
  };

  push(0, { type: "llm_request", phase: "gathering", model: "glm-4.7", tools: ["collect_preferences"] });
  push(0, { type: "llm_response", stopReason: "tool_use", thought: "用户说预算但没说目的地", toolCalls: [{ name: "collect_preferences" }] });
  push(0, { type: "tool_exec", tool: "collect_preferences", durationMs: 1200, fallbackLevel: 0 });
  push(0, { type: "state_change", op: "set", field: "preferences", valueSummary: { destination: "东京" } });
  // ... 后续事件
  return events;
}

function writeFixture(name: string, events: TraceEvent[]): void {
  const jsonl = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(`scripts/_trace-fixtures/${name}.jsonl`, jsonl, "utf8");
}

// CLI: npx tsx scripts/_trace-fixtures/_generator.ts
```

**好处**:
- Fixtures 类型安全(TraceEvent 编译时校验)
- 改字段时一行改 generator,4 个 fixture 同步更新
- Generator 本身也能跑单测(验证生成的 events 合法)

---

## 6. 单文件 HTML 约束

### 6.1 无外部依赖

- ❌ 不引入 React / Vue / Tailwind / 任何 CDN
- ❌ 不加载外部字体(用系统字体栈:`system-ui, -apple-system, "Segoe UI", sans-serif`)
- ✅ CSS 内嵌 `<style>`,JS 内嵌 `<script>`

### 6.2 体积上限

| 元素 | 上限 |
|------|------|
| 单文件 HTML 总大小 | 500 KB |
| 内嵌 CSS | 15 KB |
| 内嵌 JS | 30 KB |
| trace 数据(`iterCards` 序列化) | 400 KB |
| DOM 节点数 | < 50,000 |

**超限保护**:
```ts
const MAX_HTML_SIZE = 500 * 1024;  // 500KB
const MAX_EVENTS = 2000;

function buildSessionTraceSafe(sid: string, events: TraceEvent[]): SessionTrace {
  if (events.length > MAX_EVENTS) {
    console.warn(`[trace-viewer] ${events.length} events > ${MAX_EVENTS}, truncating to first ${MAX_EVENTS}.`);
    events = events.slice(0, MAX_EVENTS);
  }
  return buildSessionTrace(sid, events);
}
```

超限时 HTML 顶部加红色 banner:
```html
<div class="banner-warn">⚠ Trace truncated: 3,421 events → showing first 2,000. Use --range 0-500 to paginate.</div>
```

### 6.3 浏览器兼容

- Chrome 100+ / Firefox 100+ / Safari 15+
- 用原生 ES2020(`<script type="module">` 不需要)
- CSS Grid 布局(`display: grid` 三栏)

---

## 7. 测试计划

### 7.1 单元测试(`scripts/__tests__/trace-aggregator.test.ts`)

table-driven,覆盖聚合逻辑:

```ts
describe("trace-aggregator", () => {
  describe("aggregateByIter", () => {
    it("groups events by iter number", () => { /* ... */ });
    it("handles phase_change (keeps from-phase in card)", () => { /* ... */ });
    it("tolerates malformed lines (logs warning, continues)", () => { /* ... */ });
    it("sorts tool_execs by ts", () => { /* ... */ });
    it("collects unknown event types into unknownEvents", () => { /* ... */ });
  });

  describe("buildPhaseTimeline", () => {
    it("returns single segment if no phase_change events", () => { /* ... */ });
    it("builds segments from phase_change events", () => { /* ... */ });
    it("handles trailing phase (after last phase_change)", () => { /* ... */ });
  });

  describe("buildSessionTrace stats", () => {
    it("counts toolCallCount correctly", () => { /* ... */ });
    it("counts fallbackUsage (L>0) correctly", () => { /* ... */ });
    it("computes fallbackRate as fallbackTotal / callsTotal", () => { /* ... */ });
    it("computes durationMs from first/last ts", () => { /* ... */ });
  });

  describe("fixtures", () => {
    it("happy-path fixture: 12 iters, 0 fallback", () => { /* ... */ });
    it("fallback-recovery fixture: 2 L>0 calls", () => { /* ... */ });
    it("json-repair fixture: 3 errors, budgetRound 0→3", () => { /* ... */ });
    it("phase-stuck fixture: 3 rejections, force_finish", () => { /* ... */ });
  });
});
```

### 7.2 快照测试(`scripts/__tests__/trace-viewer.test.ts`)

```ts
import { writeFileSync } from "node:fs";

describe("trace-viewer snapshots", () => {
  for (const fixture of ["happy-path", "fallback-recovery", "json-repair", "phase-stuck"]) {
    it(`renders ${fixture} fixture`, () => {
      const events = readTraceJsonl(`scripts/_trace-fixtures/${fixture}.jsonl`);
      const session = buildSessionTrace(fixture, events);
      const html = renderHtml(session);
      expect(html).toMatchSnapshot();
      expect(html.length).toBeLessThan(500 * 1024);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain(fixture);
    });
  }
});
```

**快照文件位置**:`scripts/__tests__/__snapshots__/trace-viewer.test.ts.snap`

**更新快照**:`npx vitest -u` 后人工 diff 确认。

### 7.3 smoke test(留到 P2 末尾)

P2-A 单独完成时**不要求**真实 trace 数据。P2 全部完成后用真实会话跑一次,记录到 progress.md。

### 7.4 验收 checklist

- [ ] `npx tsx scripts/trace-viewer.ts --latest` 在空 trace 目录下给出友好提示
- [ ] 4 个 fixture 渲染出的 HTML 在 Chrome 打开无 console error
- [ ] 单文件 HTML 体积 ≤ 500KB(4 个 fixture 都满足)
- [ ] 快照测试可重放(git diff 友好)
- [ ] `aggregateByIter` 单测覆盖率 ≥ 90%
- [ ] `buildSessionTrace.stats` 单测覆盖率 = 100%

---

## 8. P2-A step plan(4-5 天)

### Step 1:trace-aggregator.ts + 单测(1.5 天)

文件:
- `scripts/trace-aggregator.ts`(新建)
- `scripts/__tests__/trace-aggregator.test.ts`(新建)

内容:
- §1 完整实现(6 个 export 函数)
- import type from `src/runtime/trace.js`
- table-driven 单测覆盖聚合 + 统计

Commit: `feat(scripts): trace aggregator with iter card logic`

### Step 2:trace-html-renderer.ts(1.5 天)

文件:
- `scripts/trace-html-renderer.ts`(新建)

内容:
- §2 完整实现(纯函数 `renderHtml`)
- §3 fallback_level 可视化(复用 `TOOL_FALLBACK_CHAIN`)
- §6 体积上限保护
- CSS Grid 三栏布局 + 响应式

Commit: `feat(scripts): trace-viewer three-column HTML renderer`

### Step 3:trace-viewer.ts CLI(0.5 天)

文件:
- `scripts/trace-viewer.ts`(新建)

内容:
- §4 完整实现(`parseArgs` + `main`)
- `--watch` 用 `fs.watch`
- `--open` 用 `child_process.exec` 跨平台启动浏览器

Commit: `feat(scripts): trace-viewer CLI with --sid/--latest/--all/--watch/--open`

### Step 4:mock fixtures + 快照测试(1 天)

文件:
- `scripts/_trace-fixtures/_generator.ts`(新建)
- `scripts/_trace-fixtures/*.jsonl`(generator 产出,git 提交)
- `scripts/__tests__/trace-viewer.test.ts`(新建,4 个快照)

内容:
- §5.1-5.5 generator 完整实现
- §7.2 快照测试

Commit: `test(scripts): trace-viewer fixtures and snapshot tests (4 scenarios)`

### Step 5(可选):progress.md 更新 + integration smoke

- 跑 `npm test` 确认所有单测通过
- `npx tsx scripts/trace-viewer.ts --latest --trace-dir scripts/_trace-fixtures --open` 在浏览器验证
- 更新 `progress.md` 加一条 P2-A 完成记录

Commit: `docs(progress): P2-A trace-viewer delivered`

---

## 9. 启动检查清单

- [ ] 本文档已 review
- [ ] `docs/agent-loop-redesign.md` §4.5 / §4.6 已对照
- [ ] `src/runtime/trace.ts` 的 `TraceEvent` union 已锁定(P0-A 已完成,不再变)
- [ ] `src/tools/policy.ts` 的 `TOOL_FALLBACK_CHAIN` 已锁定(P0-A 已完成)
- [ ] vitest 已配置(项目根目录有 `vitest.config.ts`)
- [ ] `npx tsx` 可运行(已有其他 scripts 用 tsx)
- [ ] git 主分支干净,新分支 `feat/p2-a-trace-viewer` 已建

review 通过后,从 §8 Step 1 开始。

---

## 10. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §4.5 / §4.6 / §5 / §8 | trace 格式 + Timeline viewer + P2-A 任务 + 验收 |
| `docs/p0-a-contracts.md` §1.4 / §2 | applyToolEffects + plan_transit(trace 事件源头) |
| `docs/p2-b-contracts.md` §3.3 / §4.1 | LLM 自评 + review-feedback.ts 依赖 trace 数据 |
| `docs/p2-c-contracts.md` §2 / §3 | fallback_level 可视化语义 + fallback-report.ts |
| `nodejs/src/runtime/trace.ts:5-91` | TraceEvent union(本文档直接 import) |
| `nodejs/src/tools/policy.ts:102-117` | TOOL_FALLBACK_CHAIN(fallback source 名) |
| `nodejs/src/runtime/state.ts:80-111` | AgentState 字段(state diff 渲染参考) |
