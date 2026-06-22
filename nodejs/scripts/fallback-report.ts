import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TRACE_DIR = path.join(PROJECT_ROOT, "data", "trace");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "data", "feedback");

interface ToolExecEvent {
  type: "tool_exec";
  tool: string;
  fallbackLevel: number;
  durationMs: number;
  resultSummary: unknown;
}

interface ToolStats {
  total: number;
  fallbacks: number;
  levels: Record<number, number>;
}

function isToolExec(line: Record<string, unknown>): line is ToolExecEvent {
  return line.type === "tool_exec" && typeof line.tool === "string";
}

function loadToolExecs(): Map<string, ToolStats> {
  if (!fs.existsSync(TRACE_DIR)) return new Map();
  const stats = new Map<string, ToolStats>();
  const files = fs.readdirSync(TRACE_DIR).filter(f => f.endsWith(".jsonl"));

  for (const file of files) {
    const content = fs.readFileSync(path.join(TRACE_DIR, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (!isToolExec(ev)) continue;
        if (!stats.has(ev.tool)) {
          stats.set(ev.tool, { total: 0, fallbacks: 0, levels: {} });
        }
        const s = stats.get(ev.tool)!;
        s.total++;
        if (ev.fallbackLevel > 0) {
          s.fallbacks++;
          s.levels[ev.fallbackLevel] = (s.levels[ev.fallbackLevel] ?? 0) + 1;
        }
      } catch { /* skip malformed lines */ }
    }
  }
  return stats;
}

function generateReport(stats: Map<string, ToolStats>, month: string): string {
  const entries = [...stats.entries()].sort((a, b) => b[1].fallbacks - a[1].fallbacks);
  const totalCalls = entries.reduce((sum, [, s]) => sum + s.total, 0);
  const totalFallbacks = entries.reduce((sum, [, s]) => sum + s.fallbacks, 0);
  const overallRate = totalCalls > 0 ? ((totalFallbacks / totalCalls) * 100).toFixed(1) : "0.0";

  let md = `# 降级链监控报告 - ${month}\n\n`;
  md += `生成时间：${new Date().toISOString().slice(0, 10)}\n`;
  md += `扫描文件数：${fs.existsSync(TRACE_DIR) ? fs.readdirSync(TRACE_DIR).filter(f => f.endsWith(".jsonl")).length : 0}\n\n`;

  md += `## 全局指标\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 总调用次数 | ${totalCalls} |\n`;
  md += `| 降级次数 | ${totalFallbacks} |\n`;
  md += `| 整体降级率 | ${overallRate}% |\n\n`;

  md += `## 按工具统计\n\n`;
  md += `| 工具 | 调用次数 | 降级次数 | 降级率 | L1/L2 |\n`;
  md += `|------|---------|---------|--------|-------|\n`;

  for (const [tool, s] of entries) {
    const rate = s.total > 0 ? ((s.fallbacks / s.total) * 100) : 0;
    const alert = rate >= 30 ? " 🔴" : rate >= 15 ? " 🟡" : "";
    const levelBreakdown = [1, 2].map(l => s.levels[l] ?? 0).join("/");
    md += `| \`${tool}\` | ${s.total} | ${s.fallbacks} | ${rate.toFixed(1)}%${alert} | ${levelBreakdown} |\n`;
  }

  const highAlert = entries.filter(([, s]) => s.total > 0 && (s.fallbacks / s.total) >= 0.3);
  if (highAlert.length > 0) {
    md += `\n## 告警\n\n`;
    for (const [tool, s] of highAlert) {
      const rate = ((s.fallbacks / s.total) * 100).toFixed(1);
      md += `- **${tool}** 降级率 ${rate}%（${s.fallbacks}/${s.total}），超过 30% 告警阈值\n`;
    }
  }

  return md;
}

function main() {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf("--month");
  const month = monthIdx >= 0 ? args[monthIdx + 1] : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error("Usage: npx tsx scripts/fallback-report.ts --month 2026-06");
    process.exit(1);
  }

  const stats = loadToolExecs();
  if (stats.size === 0) {
    console.log("No trace data found");
    return;
  }

  const report = generateReport(stats, month);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `fallback-report-${month}.md`);
  fs.writeFileSync(outPath, report, "utf-8");
  console.log(`[OK] ${outPath} (${stats.size} tools, ${[...stats.values()].reduce((s, st) => s + st.total, 0)} calls)`);
}

main();
