import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

interface EvalMetrics {
  hitRateAt5: number;
  hitRateAt10: number;
  mrr: number;
  ndcgAt10: number;
  recallAt5: number;
  avgLatencyMs: number;
}

interface EvalResult {
  variantId: string;
  timestamp: string;
  metrics: EvalMetrics;
  perCategory: Record<string, { hitRateAt5: number; mrr: number }>;
  perQueryHits?: number[];
  perQueryNdcg?: number[];
  invariantViolations?: string[];
}

function bootstrapCI(a: number[], b: number[], iterations: number): { delta: number; pValue: number } {
  if (a.length === 0 || b.length === 0) return { delta: 0, pValue: 1 };
  const observedDelta = b.reduce((s, v) => s + v, 0) / b.length - a.reduce((s, v) => s + v, 0) / a.length;
  if (a.length === 1 && b.length === 1) {
    return { delta: +observedDelta.toFixed(4), pValue: observedDelta === 0 ? 1 : 0 };
  }
  const pooled = [...a, ...b];
  let countExtreme = 0;
  for (let i = 0; i < iterations; i++) {
    const ba: number[] = [];
    const bb: number[] = [];
    for (let j = 0; j < a.length; j++) ba.push(pooled[Math.floor(Math.random() * pooled.length)]);
    for (let j = 0; j < b.length; j++) bb.push(pooled[Math.floor(Math.random() * pooled.length)]);
    const delta = bb.reduce((s, v) => s + v, 0) / bb.length - ba.reduce((s, v) => s + v, 0) / ba.length;
    if (Math.abs(delta) >= Math.abs(observedDelta)) countExtreme++;
  }
  return { delta: +observedDelta.toFixed(4), pValue: countExtreme / iterations };
}

function main() {
  const resultsDir = resolve(process.argv[2] ?? "data/rag/eval-results");
  const files = readdirSync(resultsDir).filter((f: string) => f.startsWith("eval-") && f.endsWith(".json"));
  if (files.length < 2) {
    console.error(`需要 ≥2 个结果文件 (找到 ${files.length})`);
    process.exit(1);
  }

  const allResults: EvalResult[] = files.map((f: string) => JSON.parse(readFileSync(resolve(resultsDir, f), "utf-8")));
  const latestByVariant = new Map<string, EvalResult>();
  for (const r of allResults) {
    const prev = latestByVariant.get(r.variantId);
    if (!prev || r.timestamp > prev.timestamp) latestByVariant.set(r.variantId, r);
  }
  const results = [...latestByVariant.values()];

  const baselineId = process.argv[3] ?? "baseline";
  const baseline = results.find(r => r.variantId === baselineId);
  const variants = results.filter(r => r.variantId !== baselineId);
  if (!baseline) { console.error(`基线 ${baselineId} 未找到`); process.exit(1); }

  const keys: (keyof EvalMetrics)[] = ["hitRateAt5", "mrr", "ndcgAt10", "avgLatencyMs"];
  const lines: string[] = ["# RAG 对比报告", `基线: ${baselineId}(latest)`, `对比: ${variants.map(v => v.variantId).join(", ")}`, ""];
  lines.push("| 指标 | 基线 | " + variants.map(v => v.variantId).join(" | ") + " | Δ | p | 显著? |");
  lines.push("|---|---" + variants.map(() => "---").join("|") + "|---|---|---|");

  const allDeltasZero: Record<string, boolean> = { hitRateAt5: true, mrr: true, ndcgAt10: true };
  for (const key of keys) {
    const b = baseline.metrics[key];
    for (const v of variants) {
      const val = v.metrics[key];
      const isPct = key !== "avgLatencyMs";
      const aArr = key === "hitRateAt5" || key === "hitRateAt10"
        ? (baseline.perQueryHits ?? [b])
        : key === "ndcgAt10"
          ? (baseline.perQueryNdcg ?? [b])
          : key === "avgLatencyMs" ? [b] : [b];
      const bArr = key === "hitRateAt5" || key === "hitRateAt10"
        ? (v.perQueryHits ?? [val])
        : key === "ndcgAt10"
          ? (v.perQueryNdcg ?? [val])
          : key === "avgLatencyMs" ? [val] : [val];
      const ci = bootstrapCI(aArr, bArr, 1000);
      const delta = val - b;
      const sig = key === "avgLatencyMs" ? delta < -5 : Math.abs(delta) >= 0.03 && ci.pValue < 0.05;
      if (key in allDeltasZero && delta !== 0) allDeltasZero[key] = false;
      lines.push(`| ${key} | ${isPct ? (b * 100).toFixed(1) + "%" : b.toFixed(0) + "ms"} | ${isPct ? (val * 100).toFixed(1) + "%" : val.toFixed(0) + "ms"} | ${isPct ? (delta * 100).toFixed(1) + "%" : delta.toFixed(0) + "ms"} | ${ci.pValue.toFixed(4)} | ${sig ? "✅" : "❌"} |`);
    }
  }

  lines.push("", "## Layer 4: Measurement System Sanity Check", "");
  const suspectKeys = Object.entries(allDeltasZero).filter(([, v]) => v).map(([k]) => k);
  if (suspectKeys.length > 0) {
    lines.push(
      `⚠️ **SUSPECT MEASUREMENT SYSTEM**: 以下指标在所有 variant 中 delta=0: ${suspectKeys.join(", ")}`,
      "",
      "不同算法不可能在所有指标上完全一致。可能原因:",
      "1. city filter 短路(本 variant 测试 0 条结果)",
      "2. fallback 路径绕过 variant 分支",
      "3. eval 指标实现 bug(NDCG = 1.0 异常等)",
      "4. store 数据问题导致所有 query 走相同路径",
      "",
      "**下一步**: 先调 \`scripts/verify-store.ts\`,再逐 variant 加日志确认分支真的被执行。",
      "",
    );
  } else {
    lines.push("✅ 所有 variant 之间至少有一项指标 delta≠0,测量系统信号正常。", "");
  }

  const invariantAgg: string[] = [];
  for (const r of results) {
    for (const v of r.invariantViolations ?? []) {
      invariantAgg.push(`[${r.variantId}] ${v}`);
    }
  }
  if (invariantAgg.length > 0) {
    lines.push("## Layer 4: Invariant Violations 汇总", "");
    for (const v of invariantAgg) lines.push(`- ${v}`);
    lines.push("");
  }

  const outPath = resolve(resultsDir, `comparison-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(outPath, lines.join("\n"));
  console.log(`对比报告: ${outPath}`);
}

main();
