# P2-B 接口契约

> 关联:`docs/agent-loop-redesign.md` §4.4 / §5 P2-B / §8 验收标准 14-17
> 立项:2026-06-22
> 状态:**Hard contract** — P2-B 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:锁定反馈收集 → LLM 自评 → 失败模式聚类 → prompt 版本管理的闭环接口,让"低分会话"自动流入下次 prompt 修订决策

---

## 0. 文档定位

P2-A 把 trace jsonl 变成可浏览 HTML 后,下一步是**结构化收集反馈**,让"为什么这次行程不好"可统计、可聚类、可行动。redesign v2 §4.4 提出了数据飞轮设想,本文档锁定:

- §1:`/api/feedback` 4 个端点契约(存储、读取、评分、列出)
- §2:chat.html 1-5 星评分 UI(零依赖,纯原生 DOM)
- §3:LLM 自评流程(prompt、trigger、存储)
- §4:`scripts/review-feedback.ts` 月度复盘脚本(产出 patterns.md)
- §5:prompt 版本管理(`docs/prompt-versions/system-v{N}.md` + TS 同步)
- §6:optimization-log.md 入口流程(数据飞轮"最后一公里")
- §7:数据飞轮节奏 + 触发条件
- §8:测试计划
- §9:step plan(5-6 天,本会话不实现)

**关键依赖**:P2-A 已落地(trace-viewer 可用),便于人工查看低分会话的完整 trace。

---

## 1. `/api/feedback` 端点契约

### 1.1 端点总览

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/feedback` | finalize 后前端自动上报会话记录 |
| `POST` | `/api/feedback/:sid/rate` | 用户提交 1-5 星评分 |
| `GET`  | `/api/feedback/:sid` | 读取单个 feedback record(给 review-feedback.ts 用) |
| `GET`  | `/api/feedback/sessions?since=YYYY-MM-DD` | 列出所有已记录的 feedback(给 review-feedback.ts 用) |

### 1.2 POST `/api/feedback` — finalize 后自动上报

**触发时机**:Agent Loop `finalize_plan` 成功且 phase 转到 completed 后,前端收到 `done` SSE 事件 → 自动 POST(不等用户操作)。

**Request body**:
```ts
interface FeedbackCreateRequest {
  sid: string;                  // session id
  plan: TravelPlan;             // finalize 输出的完整行程
  traceSummary: TraceSummary;   // 见下
  userMessage: string;          // 触发本次规划的原始用户消息
  agentVersion?: string;        // 从 package.json 或 git SHA 读
}

interface TraceSummary {
  totalIters: number;
  durationMs: number;
  toolCallCount: Record<string, number>;
  fallbackUsage: Record<string, number>;
  fallbackRate: number;
  errorCount: number;
  phaseTimeline: Array<{ phase: Phase; iterCount: number }>;
}
```

**响应**:`201 Created` + `{ ok: true, sid, recordPath: "data/feedback/sessions/{sid}.json" }`

**幂等性**:同一 sid 多次 POST 时**覆盖**该文件(不追加),防止前端重试导致重复。

**实现**:
```ts
// src/api/routes.ts (扩展)
app.post("/api/feedback", async (request, reply) => {
  const body = request.body as FeedbackCreateRequest;
  if (!body?.sid || !body?.plan) {
    return reply.status(400).send({ error: "sid and plan are required" });
  }

  const dir = "data/feedback/sessions";
  await mkdir(dir, { recursive: true });

  const record: FeedbackRecord = {
    sid: body.sid,
    ts: new Date().toISOString(),
    userMessage: body.userMessage,
    plan: body.plan,
    traceSummary: body.traceSummary,
    agentVersion: body.agentVersion ?? readAgentVersion(),
    rating: undefined,           // 等用户提交
    llmSelfEval: undefined,      // 异步填(见 §3)
  };

  await writeFile(`${dir}/${body.sid}.json`, JSON.stringify(record, null, 2), "utf8");
  return reply.status(201).send({ ok: true, sid: body.sid });
});
```

### 1.3 POST `/api/feedback/:sid/rate` — 用户评分

**Request body**:
```ts
interface FeedbackRateRequest {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;             // 可选文本反馈,<= 1000 字符
}
```

**响应**:`200 OK` + `{ ok: true }`

**校验**:
- `rating` 必须 1-5 整数
- `comment` 超 1000 字符 → 400
- sid 对应的 feedback record 不存在 → 404(允许用户在 feedback create 前就打分?不允许,必须先有 record)

**实现**:
```ts
app.post("/api/feedback/:sid/rate", async (request, reply) => {
  const { sid } = request.params as { sid: string };
  const body = request.body as FeedbackRateRequest;
  if (!body?.rating || body.rating < 1 || body.rating > 5) {
    return reply.status(400).send({ error: "rating must be 1-5" });
  }
  if (body.comment && body.comment.length > 1000) {
    return reply.status(400).send({ error: "comment must be <= 1000 chars" });
  }

  const recordPath = `data/feedback/sessions/${sid}.json`;
  if (!await fileExists(recordPath)) {
    return reply.status(404).send({ error: "feedback record not found" });
  }

  const record = JSON.parse(await readFile(recordPath, "utf8")) as FeedbackRecord;
  record.rating = { value: body.rating, comment: body.comment, ts: new Date().toISOString() };
  await writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");

  return reply.send({ ok: true });
});
```

### 1.4 GET `/api/feedback/:sid` — 读取单 record

返回完整 `FeedbackRecord`(含 rating + llmSelfEval)。

### 1.5 GET `/api/feedback/sessions` — 列出所有

**Query params**:
- `since: YYYY-MM-DD`(可选,默认 30 天前)
- `minRating: 1-5`(可选,过滤低分)
- `unrated: true`(可选,只返未评分)

**响应**:
```ts
interface FeedbackListResponse {
  sessions: Array<{
    sid: string;
    ts: string;
    rating?: { value: number; comment?: string };
    llmSelfEval?: { overallScore: number; failureCategory?: string };
    traceSummary: { totalIters: number; fallbackRate: number; errorCount: number };
  }>;
  total: number;
}
```

### 1.6 存储格式(FeedbackRecord 完整 schema)

```ts
// data/feedback/sessions/{sid}.json
interface FeedbackRecord {
  sid: string;
  ts: string;                            // ISO 8601,记录创建时间
  userMessage: string;
  plan: TravelPlan;                      // 来自 finalize_plan 输出
  traceSummary: TraceSummary;
  agentVersion: string;                  // "package:0.x.y" 或 "git:{sha}"

  rating?: {
    value: 1 | 2 | 3 | 4 | 5;
    comment?: string;
    ts: string;                          // ISO 8601
  };

  llmSelfEval?: LlmSelfEvalRecord;       // §3 异步填入
}

interface LlmSelfEvalRecord {
  ts: string;
  overallScore: number;                  // 5 项维度平均
  scores: {
    completeness: number;                // 完整性:dayPlans 是否覆盖所有 travelDays
    diversity: number;                   // 多样性:餐厅/景点是否多元
    budget: number;                      // 预算合理:variance 是否小
    executability: number;               // 可执行:transitToNext 是否齐全
    creativity: number;                  // 创意:是否避开千篇一律
  };
  failureCategory?: FailureCategory;
  notes?: string;                        // LLM 输出的具体问题说明
}

type FailureCategory =
  | "incomplete_plan"      // 行程不完整
  | "bad_restaurant"       // 餐厅推荐差(连锁 / 风评差)
  | "budget_blow"          // 预算超限严重
  | "transit_gap"          // 交通衔接断裂
  | "low_diversity"        // 景点/餐厅单一
  | "other";
```

### 1.7 数据目录结构

```
data/feedback/
├── sessions/                       // POST /api/feedback 写入
│   ├── {sid-1}.json                // 单 session 一个文件
│   └── {sid-2}.json
├── llm-self-eval.jsonl             // §3 异步追加(只增不删)
├── patterns-2026-06.md             // §4 月度产出
├── patterns-2026-07.md
└── fallback-report-2026-06.md      // P2-C 产出,与 patterns 互补
```

**git 策略**:
- `sessions/*.json` 加入 `.gitignore`(可能含用户隐私消息)
- `llm-self-eval.jsonl` 加入 `.gitignore`(同上)
- `patterns-*.md` 提交到 git(数据飞轮输出,团队共享)
- 提供 `data/feedback/.gitignore` 模板

---

## 2. chat.html 评分 UI

### 2.1 触发时机

JS 监听 SSE `done` 事件后:
- 等 3 秒(让用户先看行程)
- 在行程卡片底部插入评分区域
- 若已评分(localStorage 记 sid → rating),显示"已反馈"状态

### 2.2 DOM 结构

```html
<section class="feedback" data-sid="{sid}" hidden>
  <div class="feedback-stars" role="radiogroup" aria-label="评分">
    <button class="star" data-value="1" aria-label="1 星">★</button>
    <button class="star" data-value="2" aria-label="2 星">★</button>
    <button class="star" data-value="3" aria-label="3 星">★</button>
    <button class="star" data-value="4" aria-label="4 星">★</button>
    <button class="star" data-value="5" aria-label="5 星">★</button>
  </div>
  <textarea class="feedback-comment"
            placeholder="可选:告诉我们那里可以改进(<= 1000 字)"
            maxlength="1000"></textarea>
  <button class="feedback-submit" disabled>提交反馈</button>
  <div class="feedback-status" hidden></div>
</section>
```

**交互逻辑**(`src/public/chat.html` 内嵌 `<script>`):

```js
function mountFeedback(sid) {
  if (localStorage.getItem(`feedback-${sid}`)) {
    showAlreadyRated(sid);
    return;
  }

  const section = document.querySelector(`.feedback[data-sid="${sid}"]`);
  section.hidden = false;

  let selectedRating = 0;
  section.querySelectorAll(".star").forEach(star => {
    star.addEventListener("click", () => {
      selectedRating = parseInt(star.dataset.value);
      paintStars(section, selectedRating);
      section.querySelector(".feedback-submit").disabled = false;
    });
    star.addEventListener("mouseenter", () => paintStars(section, parseInt(star.dataset.value)));
    star.addEventListener("mouseleave", () => paintStars(section, selectedRating));
  });

  section.querySelector(".feedback-submit").addEventListener("click", async () => {
    const comment = section.querySelector(".feedback-comment").value.trim();
    try {
      const resp = await fetch(`/api/feedback/${sid}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: selectedRating, comment: comment || undefined }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      localStorage.setItem(`feedback-${sid}`, String(selectedRating));
      section.querySelector(".feedback-status").textContent = "已反馈,感谢!";
      section.querySelector(".feedback-submit").disabled = true;
    } catch (err) {
      const pending = JSON.parse(localStorage.getItem("pending-feedback") ?? "[]");
      pending.push({ sid, rating: selectedRating, comment, ts: Date.now() });
      localStorage.setItem("pending-feedback", JSON.stringify(pending));
      section.querySelector(".feedback-status").textContent = "网络异常,已缓存,下次重试";
    }
  });
}

function paintStars(section, n) {
  section.querySelectorAll(".star").forEach((star, i) => {
    star.classList.toggle("filled", i < n);
  });
}
```

### 2.3 样式(纯 CSS,无依赖)

```css
.feedback-stars { display: inline-flex; gap: 4px; }
.star {
  background: none; border: none; cursor: pointer;
  font-size: 24px; color: #d1d5db; transition: color 150ms;
}
.star.filled, .star:hover { color: #f59e0b; }
.feedback-comment {
  display: block; width: 100%; min-height: 60px;
  margin-top: 8px; padding: 8px;
  border: 1px solid #d1d5db; border-radius: 4px;
  font: inherit;
}
.feedback-submit { margin-top: 8px; padding: 6px 16px; }
.feedback-submit:disabled { opacity: 0.5; cursor: not-allowed; }
.feedback-status { margin-top: 8px; color: #6b7280; font-size: 0.875rem; }
```

### 2.4 重试机制

页面加载时检查 `localStorage["pending-feedback"]`,有未提交项则重试 POST。失败 3 次后停止重试(避免无限失败循环)。

---

## 3. LLM 自评流程

### 3.1 触发点

在 Agent Loop `finalize` 成功后**异步**触发,不阻塞用户响应:

```ts
// src/runtime/agent-loop.ts (扩展)
async function runAgentLoop(ctx, userMessage, emit): Promise<ConversationContext> {
  // ... main loop
  // 完成后
  if (state.phase === "completed") {
    ctx.agentState = state;
    void triggerLlmSelfEval(ctx);   // fire-and-forget
    return ctx;
  }
}

async function triggerLlmSelfEval(ctx: ConversationContext): Promise<void> {
  try {
    const evalResult = await callLlmSelfEval(ctx);
    await writeLlmSelfEval(ctx.sessionId, evalResult);
  } catch (err) {
    console.warn("[self-eval] failed:", (err as Error).message);
  }
}
```

### 3.2 Self-eval prompt

存放在 `docs/prompt-versions/plan-self-eval-prompt-v1.md`(versioned,见 §5):

```text
你是旅行规划质量评审员。基于以下信息给出行程评分:

【目的地】{destination}
【出行日期】{startDate} ~ {endDate}
【人数】{numTravelers}
【预算】¥{budget}

【行程 JSON】
{planJson}

【会话统计】
- 总迭代数:{totalIters}
- 工具调用次数:{toolCallCount}
- 降级次数:{fallbackCount}
- 错误次数:{errorCount}

【评分维度】(各 1-5 分,1=极差,5=优秀)
1. completeness(完整性):dayPlans 是否覆盖所有 travelDays?每天 dining 是否齐全?
2. diversity(多样性):餐厅是否多元(无连锁、本地特色 ≤60%)?景点是否差异化?
3. budget(预算合理):totalCost 与 budgetLimit 差额是否在 ±10% 内?
4. executability(可执行):每天 transitToNext 是否齐全?景点顺序地理合理?
5. creativity(创意):是否避开千篇一律(默认推荐 + 热门榜),给出小众亮点?

【输出 JSON 格式】
{
  "scores": {
    "completeness": 1-5,
    "diversity": 1-5,
    "budget": 1-5,
    "executability": 1-5,
    "creativity": 1-5
  },
  "failureCategory": "incomplete_plan | bad_restaurant | budget_blow | transit_gap | low_diversity | other",
  "notes": "1-2 句话,最关键的问题或亮点"
}

只输出 JSON,不要其他文字。
```

### 3.3 实现

```ts
// src/runtime/llm-self-eval.ts (新增)
import { LlmClient } from "../api/llm-client.js";

export async function callLlmSelfEval(ctx: ConversationContext): Promise<LlmSelfEvalRecord> {
  const prompt = buildSelfEvalPrompt(ctx);
  const resp = await LlmClient.complete({
    model: settings.LLM_LIGHT_MODEL,
    systemPrompt: "你是严格的旅行规划质量评审员。",
    userPrompt: prompt,
    temperature: 0.2,
    maxTokens: 500,
  });

  const parsed = parseSelfEvalJson(resp.text);  // 三层修复
  return {
    ts: new Date().toISOString(),
    overallScore: mean(Object.values(parsed.scores)),
    scores: parsed.scores,
    failureCategory: parsed.failureCategory,
    notes: parsed.notes,
  };
}

async function writeLlmSelfEval(sid: string, record: LlmSelfEvalRecord): Promise<void> {
  const dir = "data/feedback";
  await mkdir(dir, { recursive: true });
  await appendFile(`${dir}/llm-self-eval.jsonl`, JSON.stringify({ sid, ...record }) + "\n", "utf8");

  const recordPath = `${dir}/sessions/${sid}.json`;
  if (await fileExists(recordPath)) {
    const existing = JSON.parse(await readFile(recordPath, "utf8"));
    existing.llmSelfEval = record;
    await writeFile(recordPath, JSON.stringify(existing, null, 2), "utf8");
  }
}
```

### 3.4 failureCategory 分类规则

LLM 在 prompt 里被告知枚举值,**自由选择最贴近的一项**。review-feedback.ts(§4)按此字段聚类。

| Category | 触发条件 |
|----------|---------|
| `incomplete_plan` | dayPlans 数 < travelDays 或 dining 不完整 |
| `bad_restaurant` | 餐厅含连锁品牌,或本地特色 > 60% |
| `budget_blow` | totalCost 超 budgetLimit 10%+ |
| `transit_gap` | 任意 DayPlan 缺 transitToNext |
| `low_diversity` | 同一餐厅重复,或景点类别单一 |
| `other` | 不属于以上但 LLM 仍打低分 |

### 3.5 失败容错

- LLM 调用超时/失败 → 写 `{sid, error, ts}` 到 `llm-self-eval.jsonl`,不更新 sessions/{sid}.json
- JSON parse 失败 → 用 P1-A 的 `parsePlanLoose` 三层修复(jsonrepair + simpleRepair),仍失败记 error
- 评分维度不全 → 整条记录丢弃

---

## 4. `scripts/review-feedback.ts`

### 4.1 目标

扫描 `data/feedback/sessions/*.json`,按 `failureCategory` + 用户 `rating` 聚类,产出 `patterns-{YYYY-MM}.md` 供人工 review。

### 4.2 CLI

```bash
# 本月复盘
npx tsx scripts/review-feedback.ts --month current

# 指定月份
npx tsx scripts/review-feedback.ts --month 2026-06

# 时间范围
npx tsx scripts/review-feedback.ts --from 2026-06-01 --to 2026-06-30

# 自定义目录
npx tsx scripts/review-feedback.ts --month current --feedback-dir data/feedback
```

### 4.3 输出格式

```markdown
# Feedback Patterns — 2026-06

> 自动生成:2026-06-30 23:59:00 UTC
> 覆盖范围:2026-06-01 ~ 2026-06-30
> 会话总数:48(评分 35 / 未评分 13)
> 平均评分:3.4 / 5
> 低分会话(≤ 2):8 个

## 按 failureCategory 聚类

### Pattern #1: budget_blow
**count**: 6 (占低分会话 75%)
**sample sids**:
- `abc123` (rating=1, variance=+4500, 2026-06-12)
- `def456` (rating=2, variance=+3200, 2026-06-18)
- ...

**共性症状**:
- 平均预算差额:+3800(标准差 800)
- 多发于:东京 / 京都(住宿占 50%+)
- 触发:用户 budget < 10000/天

**root cause 假设**:planning 阶段酒店成本估算偏低,未触发 budgetRound 回退。

**建议 action**:
- 在 `search_hotels` 工具里加 `maxPricePerNight` 强制过滤(P0-B 已有,需在 prompt 里强化)
- system-prompt v{N+1} 加约束:"如果 user budget < 8000/天,优先推荐民宿胶囊"

---

### Pattern #2: bad_restaurant
**count**: 2
...
```

### 4.4 实现

```ts
// scripts/review-feedback.ts
interface Pattern {
  id: number;
  category: FailureCategory;
  count: number;
  sampleSids: Array<{ sid: string; rating?: number; ts: string; notes?: string }>;
  commonSymptoms: string[];
  rootCauseHypothesis: string;
  suggestedAction: string[];
}

async function main() {
  const args = parseArgs(process.argv);
  const records = await loadRecords(args.feedbackDir, args.from, args.to);

  const lowRated = records.filter(r => r.rating && r.rating.value <= 2);
  console.log(`[review-feedback] ${records.length} records, ${lowRated.length} low-rated`);

  const byCategory = groupByCategory(lowRated);
  const patterns = buildPatterns(byCategory);

  const outPath = `${args.feedbackDir}/patterns-${args.month}.md`;
  await writeFile(outPath, renderPatternsMarkdown(args.month, patterns, records), "utf8");
  console.log(`[OK] ${outPath}  (${patterns.length} patterns)`);
}
```

### 4.5 触发节奏

- **每周一** 09:00 cron:`npx tsx scripts/review-feedback.ts --month current`
- 产出自动 git commit:`chore(feedback): patterns for week of {date}`
- 团队周一站会过 patterns,标记 actionable 的

---

## 5. prompt 版本管理

### 5.1 目录结构

```
docs/prompt-versions/
├── README.md                              // 版本编号规则 + A/B 流程
├── system-v1.md                           // 当前生效的 system prompt 快照
├── system-v2.md                           // 下一版(P2-A 完成后)
├── plan-self-eval-prompt-v1.md            // §3.2 的 self-eval prompt
└── ...
```

### 5.2 与 TS 实现的同步策略

**双写**:
- `src/runtime/system-prompt.ts` 是**编译时**生效的代码
- `docs/prompt-versions/system-v{N}.md` 是**只读快照**,人看的

**每次 v{N} → v{N+1} 切换**:
1. 改 `src/runtime/system-prompt.ts`(真实改动)
2. 运行 `npx tsx scripts/snapshot-prompt.ts`(新脚本,从 TS 提取字符串字面量 → 写 markdown)
3. 在 `docs/optimization-log.md` 追加一条变更记录(见 §6)
4. PR review 时 reviewer 对照 TS diff + markdown diff

**snapshot 脚本契约**:
```ts
// scripts/snapshot-prompt.ts
import { BASE_PROMPT, PHASE_PROMPTS } from "../src/runtime/system-prompt.js";
import { writeFileSync } from "node:fs";

const version = process.argv[2] ?? nextVersion();
const content = `# system-v${version}

> 自动快照:从 src/runtime/system-prompt.ts @ git:{sha} 生成
> 生成时间:${new Date().toISOString()}

## BASE_PROMPT

${BASE_PROMPT}

## PHASE_PROMPTS

${Object.entries(PHASE_PROMPTS).map(([phase, text]) => `### ${phase}\n\n${text}`).join("\n\n")}
`;
writeFileSync(`docs/prompt-versions/system-v${version}.md`, content, "utf8");
```

### 5.3 README.md 内容

```markdown
# Prompt Versions

每个 \`system-v{N}.md\` 是 \`src/runtime/system-prompt.ts\` 在某个 git commit 的快照。

## 编号规则

- v1 = P0-A 交付时的初始版本
- 每次修订 +1(v2 → v3 → ...),不跳跃
- 回滚也算一次版本(记录在 optimization-log.md)

## A/B 对比流程

1. 跑 v{N}(基线)50 case,记录指标到 \`optimization-log.md\`
2. 改 \`system-prompt.ts\` + snapshot 出 v{N+1}
3. 跑 v{N+1} 50 case(同 eval set)
4. 对照 A/B 指标表决策:
   - **adopt**:v{N+1} → main,所有新会话用新版本
   - **reject**:回滚 TS 改动,记 v{N+1} 为 deprecated
   - **iterate**:小修后再跑一次

## 当前生效版本

- **system-v1**(自 2026-06-18 起生效,见 \`src/runtime/system-prompt.ts\`)
```

---

## 6. optimization-log.md 入口流程

### 6.1 触发条件

任何以下变更**必须**在 `docs/optimization-log.md` 追加一条记录:

| 变更类型 | 例子 |
|---------|------|
| prompt 修订 | system-prompt.ts BASE 或 PHASE_PROMPTS 任一字符串改 |
| 参数调整 | temperature / maxTokens / model 选择变化 |
| 工具定义变更 | 新增工具 / 删除工具 / 工具描述改 |
| policy 调整 | phase gating 规则 / TOOL_FALLBACK_CHAIN 修改 |

### 6.2 强制字段(模板已在 optimization-log.md 定义)

```markdown
## [YYYY-MM-DD] 变更类型(prompt / 参数 / 工具)

**触发源**:
- [ ] patterns-{YYYY-MM}.md 的某条 pattern(引用 ID,如 Pattern #1)
- [ ] 用户反馈(评分 ≤ 2 的 case,引用 sid)
- [ ] LLM 自评低分 case(引用 sid + failureCategory)
- [ ] 主动优化

**变更内容**:
- 文件:`src/runtime/system-prompt.ts` 的 PHASE_PROMPTS.planning
- diff 摘要:加了"如果 user budget < 8000/天,优先推荐民宿胶囊"约束
- 快照:`docs/prompt-versions/system-v1.md` → `system-v2.md`

**变更动机**:
patterns-2026-06.md Pattern #1 显示 budget_blow 占低分会话 75%,root cause 是 planning 阶段未对低预算做差异化推荐。

**A/B 测试结果**:
| 指标 | v1(基线) | v2(新) | Δ |
|------|-----------|---------|---|
| 自评均分(50 case) | 3.4 | ? | ? |
| 用户评分均分 | 3.1 | ? | ? |
| 行程完整度 | 92% | ? | ? |
| 餐厅多样性分 | 55% | ? | ? |
| 预算偏差率 | +18% | ? | ? |
| 平均工具调用次数 | 23 | ? | ? |
| 平均 latency | 47s | ? | ? |

**决策**:[adopt / reject / iterate]
- adopt → v2 转 main
- reject → 回滚,记录失败原因
- iterate → 列出下一步要改的

**副作用**:[有没有意外影响其他 case,如:高预算场景的创意分下降]
```

### 6.3 A/B 指标计算脚本

新增 `scripts/run-ab-eval.ts`(可选,P2-B 末尾):
- 输入:`--baseline v1 --variant v2 --cases 50`
- 跑:用 eval set 里的 50 个 query × 当前 TS(v2) + checkout v1 重跑
- 产出:填充上方表格 + 写回 optimization-log.md

---

## 7. 数据飞轮节奏

### 7.1 周节奏(每周一)

1. cron 跑 `scripts/review-feedback.ts --month current`
2. 自动 commit 产出的 patterns.md
3. 团队 review,标记 1-3 个 actionable pattern
4. 选择 1 个进入 A/B(下一周迭代)

### 7.2 月节奏(每月最后一天)

1. 跑 `scripts/run-ab-eval.ts --baseline v{N} --variant v{N+1}`
2. 填充 optimization-log.md 的 A/B 指标表
3. 决策:adopt / reject / iterate
4. 若 adopt,snapshot prompt + 更新 prompt-versions/README.md 的"当前生效版本"

### 7.3 季度节奏(每季度)

- 回顾 3 个月的 patterns + A/B 记录
- 总结系统性问题(如"餐厅多样性持续偏低,可能需要重做 search_restaurants 工具")
- 作为下一季度 roadmap 输入

---

## 8. 测试计划

### 8.1 API 端点测试

| 测试 | 覆盖 |
|------|------|
| POST /api/feedback(完整 body) | 201 + 文件写入 |
| POST /api/feedback(缺字段) | 400 |
| POST /api/feedback(幂等) | 同 sid 二次 POST 覆盖 |
| POST /api/feedback/:sid/rate(合法) | 200 + rating 写入 |
| POST /api/feedback/:sid/rate(rating=0) | 400 |
| POST /api/feedback/:sid/rate(rating=6) | 400 |
| POST /api/feedback/:sid/rate(comment > 1000) | 400 |
| POST /api/feedback/:sid/rate(未 create) | 404 |
| GET /api/feedback/sessions | 列表过滤 |
| GET /api/feedback/sessions?minRating=2 | 过滤 |

### 8.2 LLM 自评测试

| 测试 | 覆盖 |
|------|------|
| 正常 self-eval | 写 jsonl + 更新 record |
| LLM 超时 | 记 error 不崩 |
| JSON parse 失败 | jsonrepair 修复 |
| 评分维度缺失 | 丢弃记录 |

### 8.3 review-feedback.ts 测试

| 测试 | 覆盖 |
|------|------|
| 空 feedback 目录 | 友好提示 |
| 1 个低分 record | 1 个 pattern |
| 多个同类 category | 聚类到 1 个 pattern |
| 时间范围过滤 | 只返范围内 |
| markdown 输出 | snapshot test |

### 8.4 chat.html UI 测试

手测为主,检查:
- 星星 hover 高亮
- 点击后提交按钮 enable
- 提交成功后 localStorage 记录
- 网络失败时 pending 缓存
- 重启页面后 pending 重试

---

## 9. P2-B step plan(5-6 天,本会话不实现)

### Step 1:目录 + gitignore + 数据 schema(0.5 天)

- 建 `data/feedback/{sessions,llm-self-eval.jsonl}` 空目录 + .gitignore
- `src/feedback/types.ts`(FeedbackRecord + LlmSelfEvalRecord 类型)
- Commit: `feat(feedback): types and storage layout`

### Step 2:/api/feedback 4 个端点(1.5 天)

- `src/api/routes.ts` 扩展 4 个路由
- `src/feedback/feedback-store.ts`(读写 sessions/{sid}.json)
- 集成测试覆盖 §8.1

Commit: `feat(api): /api/feedback endpoints (create/rate/get/list)`

### Step 3:LLM 自评 + 异步触发(1 天)

- `src/runtime/llm-self-eval.ts`
- `docs/prompt-versions/plan-self-eval-prompt-v1.md`
- Agent Loop 完成时 fire-and-forget 调用

Commit: `feat(runtime): LLM self-eval with 5-dimension scoring`

### Step 4:chat.html 评分 UI(1 天)

- `src/public/chat.html` 加 `<section class="feedback">`
- 内嵌 JS + CSS
- localStorage 重试逻辑

Commit: `feat(frontend): 1-5 star feedback UI with offline retry`

### Step 5:review-feedback.ts 月度脚本(1 天)

- `scripts/review-feedback.ts`
- 按 failureCategory 聚类
- patterns.md 输出 + snapshot test

Commit: `feat(scripts): review-feedback.ts monthly pattern clustering`

### Step 6:prompt-versions + optimization-log 接线(0.5 天)

- `docs/prompt-versions/{README.md,system-v1.md}`(快照当前)
- `scripts/snapshot-prompt.ts`
- 验证 optimization-log.md 模板可用

Commit: `feat(process): prompt versioning and optimization-log workflow`

### Step 7(可选):A/B eval 脚本

- `scripts/run-ab-eval.ts`
- 只跑 eval set × 当前版本,基线版本对比作为后续迭代

Commit: `feat(scripts): A/B eval harness for prompt variants`

---

## 10. 启动检查清单

- [ ] P2-A 已落地(trace-viewer 可用,人工能查低分会话)
- [ ] `/api/chat/:sid` 路径稳定,Agent Loop finalize 正常产出 plan
- [ ] Fastify 已注册 feedback routes(空 stub 可)
- [ ] `data/feedback/` 目录规划完成
- [ ] chat.html 已能接收 `done` SSE 事件
- [ ] LLM client 支持 `temperature: 0.2` 低温度调用
- [ ] git 主分支干净,新分支 `feat/p2b-feedback-flywheel` 已建

---

## 11. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §4.4 / §5 P2-B / §8 验收 14-17 | 数据飞轮 + P2-B 任务 + 验收标准 |
| `docs/p2-a-contracts.md` §1 / §7 | trace-viewer 读取 jsonl(低分会话人工复盘入口) |
| `docs/p2-c-contracts.md` §3 | fallback-report.ts 与 patterns.md 共存于 data/feedback/ |
| `docs/optimization-log.md` | 数据飞轮最后一公里(变更决策记录) |
| `docs/prompt-versions/README.md` | prompt 版本管理流程 |
| `nodejs/src/api/routes.ts` | Fastify 路由(扩展点) |
| `nodejs/src/runtime/agent-loop.ts` | LLM 自评触发点(finalize 后) |
| `nodejs/src/public/chat.html` | 评分 UI 注入点 |
