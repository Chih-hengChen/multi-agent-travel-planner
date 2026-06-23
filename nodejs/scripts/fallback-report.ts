import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TraceEvent } from "../src/runtime/trace.js";

interface ToolFallbackStats {
  tool: string;
  totalCalls: number;
  fallbackCount: number;
  byLevel: Record<number, number>;
  fallbackRate: number;
  status: "healthy" | "acceptable" | "watch" | "degraded";
}

interface CliArgs {
  month: string;
  traceDir: string;
  outDir: string;
}

const ALERT_THRESHOLD = 0.30;
const WATCH_THRESHOLD = 0.20;

export function classifyStatus(rate: number): ToolFallbackStats["status"] {
  if (rate === 0) return "healthy";
  if (rate < WATCH_THRESHOLD) return "acceptable";
  if (rate < ALERT_THRESHOLD) return "watch";
  return "degraded";
}

function parseArgs(argv: string[]): CliArgs {
  let month = "";
  let traceDir = "data/trace";
  let outDir = "data/feedback";

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--month") month = argv[++i];
    else if (a === "--trace-dir") traceDir = argv[++i];
    else if (a === "--out-dir") outDir = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }

  if (!month) month = "current";
  return { month, traceDir, outDir };
}

function printHelp(): void {
  console.log(`fallback-report — monthly tool fallback report

Usage:
  npx tsx scripts/fallback-report.ts --month current
  npx tsx scripts/fallback-report.ts --month 2026-06
  npx tsx scripts/fallback-report.ts --trace-dir data/trace --out-dir data/feedback

Options:
  --month <YYYY-MM | current>  target month (default: current)
  --trace-dir <d>              trace directory (default: data/trace)
  --out-dir <d>                output directory (default: data/feedback)
  -h, --help                   show this help`);
}

function parseMonthFilter(month: string): string {
  if (month === "current") {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month: "${month}". Expected YYYY-MM or "current".`);
  }
  return month;
}

export function listTraceFiles(traceDir: string): string[] {
  try {
    return readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

export function readTraceJsonl(filePath: string): TraceEvent[] {
  const raw = readFileSync(filePath, "utf8");
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.type && parsed.ts) {
        events.push(parsed as TraceEvent);
      }
    } catch {
      // skip malformed
    }
  }
  return events;
}

export function renderMarkdown(
  monthFilter: string,
  statsByTool: Map<string, ToolFallbackStats>,
  globalTotal: number,
  globalFallback: number,
  sessionCount: number,
  alerts: string[],
): string {
  const rows = Array.from(statsByTool.values()).sort((a, b) => b.fallbackRate - a.fallbackRate);
  const globalRate = globalTotal > 0 ? (globalFallback / globalTotal) * 100 : 0;
  const degradedCount = rows.filter((r) => r.status === "degraded").length;
  const watchCount = rows.filter((r) => r.status === "watch").length;

  let md = `# Fallback Report — ${monthFilter}

> 自动生成:${new Date().toISOString()}
> 扫描范围:${sessionCount} 个 session,${globalTotal} 次 tool_exec

## 按工具聚合

| Tool | Total Calls | Fallback Count | Fallback Rate | By Level | Status |
|------|-------------|----------------|---------------|----------|--------|
`;

  for (const s of rows) {
    const byLevelStr = Object.entries(s.byLevel)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([l, n]) => `L${l}:${n}`)
      .join(" ");
    const statusIcon = s.status === "degraded" ? "⚠ **degraded**"
      : s.status === "watch" ? "⚠ watch"
      : s.status === "acceptable" ? "✅ acceptable"
      : "✅ healthy";
    const rateStr = s.fallbackRate > 0.5 ? `**${(s.fallbackRate * 100).toFixed(1)}%**` : `${(s.fallbackRate * 100).toFixed(1)}%`;
    md += `| ${s.tool} | ${s.totalCalls} | ${s.fallbackCount} | ${rateStr} | ${byLevelStr} | ${statusIcon} |\n`;
  }

  md += `\n## 全局统计\n\n`;
  md += `- 扫描 session 数:${sessionCount}\n`;
  md += `- 总 tool_exec:${globalTotal}\n`;
  md += `- 总 fallback:${globalFallback}(L1+:${rows.reduce((a, r) => a + (r.byLevel[1] ?? 0), 0)} / L2+:${rows.reduce((a, r) => a + (r.byLevel[2] ?? 0), 0)})\n`;
  md += `- 全局 fallback rate:${globalRate.toFixed(1)}%`;
  md += globalRate > 10 ? "(⚠ 超过 10% 阈值)\n" : "(健康)\n";
  md += `- 主源不稳定工具数:${degradedCount + watchCount}\n\n`;

  if (alerts.length > 0) {
    md += `## 告警\n\n`;
    for (const alert of alerts) {
      md += alert + "\n\n";
    }
  }

  return md;
}

export function generateAlerts(
  monthFilter: string,
  statsByTool: Map<string, ToolFallbackStats>,
): string[] {
  const alerts: string[] = [];

  for (const s of statsByTool.values()) {
    if (s.status === "degraded" || s.status === "watch") {
      const level = s.fallbackRate > 0.5 ? "critical" : s.status === "degraded" ? "warn" : "watch";
      const icon = level === "critical" ? "🔴" : level === "warn" ? "⚠" : "👀";
      alerts.push(`### ${icon} ${s.tool} fallback rate ${(s.fallbackRate * 100).toFixed(1)}%(> ${s.status === "degraded" ? 30 : 20}% 阈值)

**影响**:${s.tool} 数据源健康度下降,可能影响相关推荐质量

**建议 action**:
- 检查对应主源服务状态
- 确认降级链是否正常工作(L0→L1→L2 逐级尝试)
- 若持续高 fallback,触发服务升级`);
    }
  }

  return alerts;
}

export function aggregateTraceEvents(
  files: string[],
  traceDir: string,
  monthFilter: string,
): {
  statsByTool: Map<string, ToolFallbackStats>;
  globalTotal: number;
  globalFallback: number;
  sessionCount: number;
  alerts: string[];
} {
  const statsByTool = new Map<string, ToolFallbackStats>();
  let sessionCount = 0;
  let globalTotal = 0;
  let globalFallback = 0;

  for (const f of files) {
    const filePath = join(traceDir, f);
    const events = readTraceJsonl(filePath);

    const sessionMonth = events.length > 0 ? events[0].ts.slice(0, 7) : "";
    if (sessionMonth !== monthFilter) continue;

    sessionCount++;

    for (const e of events) {
      if (e.type !== "tool_exec") continue;
      const tool = (e as any).tool as string;
      const fallbackLevel = (e as any).fallbackLevel as number ?? 0;

      let stats = statsByTool.get(tool);
      if (!stats) {
        stats = { tool, totalCalls: 0, fallbackCount: 0, byLevel: {}, fallbackRate: 0, status: "healthy" };
        statsByTool.set(tool, stats);
      }
      stats.totalCalls++;
      stats.byLevel[fallbackLevel] = (stats.byLevel[fallbackLevel] ?? 0) + 1;
      if (fallbackLevel > 0) stats.fallbackCount++;
      globalTotal++;
      if (fallbackLevel > 0) globalFallback++;
    }
  }

  for (const s of statsByTool.values()) {
    s.fallbackRate = s.totalCalls > 0 ? s.fallbackCount / s.totalCalls : 0;
    s.status = classifyStatus(s.fallbackRate);
  }

  const alerts = generateAlerts(monthFilter, statsByTool);
  return { statsByTool, globalTotal, globalFallback, sessionCount, alerts };
}

async function main() {
  const args = parseArgs(process.argv);
  const monthFilter = parseMonthFilter(args.month);
  const files = listTraceFiles(args.traceDir);

  console.log(`[fallback-report] scanning ${files.length} trace file(s) for ${monthFilter}`);

  const { statsByTool, globalTotal, globalFallback, sessionCount, alerts } =
    aggregateTraceEvents(files, args.traceDir, monthFilter);

  if (statsByTool.size === 0) {
    console.log(`[fallback-report] no matching sessions found for ${monthFilter}`);
    return;
  }

  const md = renderMarkdown(monthFilter, statsByTool, globalTotal, globalFallback, sessionCount, alerts);
  const outPath = join(args.outDir, `fallback-report-${monthFilter}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf8");
  console.log(`[OK] ${outPath}  (${sessionCount} sessions, ${globalTotal} tool_exec, ${globalFallback} fallbacks)`);
}

main().catch((err) => {
  console.error("[fallback-report]", err.message);
  process.exit(1);
});
