import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SESSIONS_DIR = path.join(PROJECT_ROOT, "data", "feedback", "sessions");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "data", "feedback");

interface SessionFeedback {
  sid: string;
  plan: {
    destination: string;
    departureCity: string;
    days: number;
    numTravelers: number;
    budget: number;
    totalCost: number;
    withinBudget: boolean;
    hotelName?: string;
    transportMode?: string;
  };
  traceSummary: {
    totalIters: number;
    toolCallCount: number;
    fallbackCount: number;
    phaseDistribution: Record<string, number>;
    errorCount: number;
  };
  userMessage: string;
  userRating?: {
    score: number;
    feedback?: string;
    ratedAt: string;
  };
  llmSelfEval?: {
    ts: string;
    sid: string;
    scores: {
      completeness: number;
      diversity: number;
      budgetReasonableness: number;
      executability: number;
      creativity: number;
    };
    failureCategory?: string;
    notes?: string;
  };
  createdAt: string;
}

interface CategoryBucket {
  category: string;
  count: number;
  sampleSids: string[];
  avgUserRating: number;
  avgSelfEval: Record<string, number>;
  commonNotes: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  incomplete_plan: "行程不完整",
  bad_restaurant: "餐厅选择差",
  budget_blow: "预算超支严重",
  transit_gap: "交通衔接缺失",
  low_diversity: "景点类型单一",
  other: "其他问题",
  none: "无缺陷",
};

const CATEGORY_HYPOTHESES: Record<string, string> = {
  incomplete_plan: "LLM 可能提前结束规划，或工具返回数据不足导致无法生成完整 dayPlans",
  bad_restaurant: "餐厅推荐数据源覆盖不全，或预算过滤条件过严",
  budget_blow: "酒店/交通价格数据与实际花费估算模型存在偏差",
  transit_gap: "交通衔接逻辑未根据景点间实际距离和开放时间进行约束",
  low_diversity: "搜索策略偏向热门景点，缺少多样性注入（如艺术展/市集/郊区游）",
  other: "需人工审查具体 notes 定位根因",
  none: "",
};

function loadSessions(): SessionFeedback[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8")) as SessionFeedback)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function filterByMonth(sessions: SessionFeedback[], month: string): SessionFeedback[] {
  return sessions.filter(s => s.createdAt.startsWith(month));
}

function clusterByCategory(sessions: SessionFeedback[]): Map<string, CategoryBucket> {
  const map = new Map<string, CategoryBucket>();

  for (const s of sessions) {
    const cat = s.llmSelfEval?.failureCategory || "none";
    if (!map.has(cat)) {
      map.set(cat, {
        category: cat,
        count: 0,
        sampleSids: [],
        avgUserRating: 0,
        avgSelfEval: {},
        commonNotes: [],
      });
    }
    const bucket = map.get(cat)!;
    bucket.count++;
    if (bucket.sampleSids.length < 3) bucket.sampleSids.push(s.sid);
    if (s.userRating) {
      bucket.avgUserRating =
        (bucket.avgUserRating * (bucket.count - 1) + s.userRating.score) / bucket.count;
    }
    if (s.llmSelfEval?.scores) {
      for (const [k, v] of Object.entries(s.llmSelfEval.scores)) {
        const prev = bucket.avgSelfEval[k] ?? 0;
        bucket.avgSelfEval[k] = (prev * (bucket.count - 1) + v) / bucket.count;
      }
    }
    if (s.llmSelfEval?.notes && bucket.commonNotes.length < 5) {
      bucket.commonNotes.push(s.llmSelfEval.notes);
    }
  }
  return map;
}

function generateReport(sessions: SessionFeedback[], buckets: Map<string, CategoryBucket>, month: string): string {
  const rated = sessions.filter(s => s.userRating);
  const evaled = sessions.filter(s => s.llmSelfEval);
  const avgUserRating = rated.length > 0
    ? rated.reduce((sum, s) => sum + (s.userRating?.score ?? 0), 0) / rated.length
    : 0;
  const avgCompleteness = evaled.length > 0
    ? evaled.reduce((sum, s) => sum + (s.llmSelfEval?.scores.completeness ?? 0), 0) / evaled.length
    : 0;

  let md = `# 反馈模式报告 - ${month}\n\n`;
  md += `生成时间：${new Date().toISOString().slice(0, 10)}\n`;
  md += `总会话数：${sessions.length}，已评分：${rated.length}，已自评：${evaled.length}\n\n`;

  md += `## 全局指标\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 用户平均评分 | ${avgUserRating.toFixed(1)}/5 |\n`;
  md += `| 自评完整性均分 | ${avgCompleteness.toFixed(1)}/5 |\n`;
  md += `| 会话总数 | ${sessions.length} |\n\n`;

  md += `## 失败模式聚类\n\n`;
  for (const [cat, bucket] of [...buckets.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const label = CATEGORY_LABELS[cat] ?? cat;
    const hypothesis = CATEGORY_HYPOTHESES[cat] ?? "";
    md += `### ${label}（${bucket.count} 次）\n\n`;
    md += `- **样本会话**：${bucket.sampleSids.map(s => `\`${s.slice(0, 8)}\``).join(", ")}\n`;
    md += `- **用户均分**：${bucket.avgUserRating > 0 ? bucket.avgUserRating.toFixed(1) : "N/A"}/5\n`;
    if (Object.keys(bucket.avgSelfEval).length > 0) {
      md += `- **自评均分**：${Object.entries(bucket.avgSelfEval).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(", ")}\n`;
    }
    md += `- **根因假设**：${hypothesis}\n`;
    if (bucket.commonNotes.length > 0) {
      md += `- **样本备注**：\n`;
      for (const note of bucket.commonNotes.slice(0, 3)) {
        md += `  - "${note}"\n`;
      }
    }
    md += `\n`;
  }

  md += `## 改进建议\n\n`;
  const topCategories = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
  for (const [cat, bucket] of topCategories) {
    if (cat === "none") continue;
    const label = CATEGORY_LABELS[cat] ?? cat;
    md += `### ${label}\n\n`;
    md += `- **优先级**：${bucket.count >= 3 ? "高" : bucket.count >= 2 ? "中" : "低"}\n`;
    md += `- **建议**：${CATEGORY_HYPOTHESES[cat]}\n`;
    md += `- **验证方式**：修改后跑 20 个相同场景 A/B 对比，关注用户评分和自评分变化\n\n`;
  }

  return md;
}

function main() {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf("--month");
  const month = monthIdx >= 0 ? args[monthIdx + 1] : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error("Usage: npx tsx scripts/review-feedback.ts --month 2026-06");
    process.exit(1);
  }

  const all = loadSessions();
  const sessions = filterByMonth(all, month);

  if (sessions.length === 0) {
    console.log(`No feedback sessions found for ${month}`);
    return;
  }

  const buckets = clusterByCategory(sessions);
  const report = generateReport(sessions, buckets, month);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `patterns-${month}.md`);
  fs.writeFileSync(outPath, report, "utf-8");
  console.log(`[OK] ${outPath} (${sessions.length} sessions, ${buckets.size} categories)`);
}

main();
