# 优化 Backlog（2026-06-26 复盘）

> 来源：当天围绕"项目可优化点 / 简历叙事修正"的深度复盘讨论
> 原则：每条带**代码证据 + 问题 + 建议 + 优先级**
> 优先级：P0 = 立刻该补 / P1 = 近期补 / P2 = 有空再说

---

## 一、RAG 系统短板

### P0-1：实装 RRF 融合替代 score-based 加权

**现状**
- V5（LLM 扩展 + 向量）/ V6（LLM 扩展 × BM25 tokens 并集）均失败
- 项目据此判定"LLM 扩展路径 definitively 废弃"（`docs/rag-optimization-log.md` §9.6）
- 失败根因被错误归因为"LLM 扩展无价值"

**问题**
- V5/V6 真正失败原因是 **IDF 稀释**：把所有扩展词并集到原 query 算一次 BM25，IDF 必然稀释
- 行业事实标准做法：**多 query 独立检索 + RRF 融合**（`score(d) = Σ 1/(60 + rank_i(d))`）
- RRF 不依赖绝对分数，只看排名 → 绕过 IDF 稀释 + 向量分低两个问题
- `grep -E "RRF|reciprocal_rank"` 在 `src/` 零匹配，**RRF 从未实装**

**建议**
- 实装 V7：原 query + 3 个 LLM 扩展词各自独立检索（向量+BM25），RRF 融合
- 30 行代码改动，V5/V6 已经把扩展词召回逻辑写好了，改成独立检索 + RRF 即可
- 对照 V0/V3 看 Hit@5 / MRR 提升

**证据**：`src/rag/rag-source.ts:200-240`（V3 score-based 加权）、`docs/rag-optimization-log.md` §8.8 + §9.7

---

### P0-2：加拒答阈值 + Negative eval set

**现状**
- 100 条 eval set 全是"应该召回到的"，**没有负面 case**
- 实测 4 条 negative query 全部返回 0.7-1.0 高分：

| Query | top-1 命中 | score |
|---|---|---|
| "推荐北京 CPU 性能最好的电脑" | 北京旅游攻略 | 0.913 |
| "今天美股大跌的原因" | 成都美食（龙抄手）| **1.000** |
| "如何用 Python 写一个 Web 服务器" | 北京 tips | 0.803 |
| "帮我写一段 JavaScript 防抖函数" | 上海 tips | 0.890 |

**问题**
- 系统对所有 query 都返回 top-5，**没有拒答机制**
- "今天美股大跌"得 1.000 是 min-max 归一化副作用：低 BM25 候选被拉到 1.0
- 生产风险：用户问无关问题时，RAG 把攻略塞给 LLM → LLM 产生幻觉回答

**建议**
- 加 10-20 条 negative query（无关领域 / 不存在景点 / prompt injection）
- 引入 score threshold + 拒答（top-1 原始 score < X 时返回"我没找到相关信息"）
- min-max 归一化前先做 BM25 绝对分数过滤（bm_raw < 阈值则丢弃）

**证据**：`data/rag/eval-v1.jsonl`（无负面 case）、`src/rag/rag-source.ts:223-228`（min-max 归一化无绝对分过滤）

---

### P0-3：修 V3 "自适应权重"实际上是空话

**现状**
- V3 公式：`alpha = max(0.05, min(0.6, maxVec * 2))`
- 看似动态，实际恒等于 0.6：

| maxVec | alpha 实际值 | 走哪条分支 |
|---|---|---|
| < 0.3 | — | 提前 return 纯 BM25 分支 |
| 0.3 | 0.6 | 融合分支 |
| ≥ 0.3 | 0.6 (clamp 上限) | 融合分支 |

**问题**
- 所谓"自适应"实际是 **二值切换**：maxVec<0.3 切纯 BM25，maxVec≥0.3 用固定 0.6/0.4 权重
- 过渡区间 (0.15, 0.3) 的 alpha 计算永远走不到——被 `if maxVec < 0.3` 提前 return 了
- 简历"自适应权重"叙事名不副实

**建议**
- 改简历叙事为"二值切换的混合检索"
- 或真把 alpha 做成连续函数：去掉 `if maxVec < 0.3` 提前 return，让 alpha 在 [0.15, 0.3] 区间也参与

**证据**：`src/rag/rag-source.ts:232-238`

---

### P1-1：补 top-2~10 命中 case 的失败模式分析

**现状**
- V3 per-query 分布：top1=70 / top2-3=10 / top4-5=6 / top6-10=3 / miss@10=11
- **非 top-1 的 30 条**中只有 miss@10 的 11 条做过逐条分析
- rank 2-10 的 19 条**没分析过**

**问题**
- 项目实际短板：只分析了"完全 miss"的，没分析"命中但 rank 偏后"的
- 无法判断 BM25 权重是否有调优空间

**建议**
- 扩展 `scripts/rag-analyze-failures.ts`：top2-10 命中的 19 条逐条分析
- 看是否集中在某个 category / 某类 query

**证据**：`data/rag/eval-results/eval-v3-2026-06-21.json`（perQueryRanks 完整数据存在）

---

### P1-2：V3 内联循环 city filter 严格相等 bug

**现状**
- 三处 city filter 实现不一致：

| 位置 | 实现 |
|---|---|
| `vector-store.ts:46-52` | 严格相等 OR startsWith |
| `rag-source.ts:206` (V3 内联) | **纯严格相等** |
| `rag-source.ts:327` (BM25 fallback) | 同 vector-store |

**问题**
- V3 候选集 = 向量召回 top-20（fuzzy）+ V3 内联扩展（strict）
- 对 eval set 5 城市（北京/上海/成都/西安/广州）不生效（已清洗，exact=fuzzy）
- 但 store 里 125 个 city 含**非标命名**：厦门八日/台湾12日/北疆/北戴河等
- 用户输入"厦门"会漏召回"厦门八日"88 条 chunks

**建议**
- V3 内联循环改成 `e.doc.metadata.city !== params.city && !e.doc.metadata.city.startsWith(params.city)` 与其他两处对齐
- 5 分钟改动，但要重跑 eval 验证 V3 指标

**证据**：`src/rag/rag-source.ts:206`、store 实测 125 cities 含非标命名

---

### P1-3：cross-encoder reranker 救词汇不对齐

**现状**
- V3 失败 11 条逐条分类：词汇不对齐 9 条 (82%) / 语料缺失 2 条 (18%) / 城市边界 0 条
- 词汇不对齐模式：query 用泛化品类词（"共享单车"/"打车软件"），chunk 用具体实体（"哈啰"/"滴滴"）
- BM25 bigram 字符层面 0 重叠，向量也救不回（embedding-3 把它们映射到不同语义簇）

**问题**
- V5 LLM 扩展试图救（"共享单车"→"哈啰/美团"），但因 IDF 稀释失败
- 真正能救的方案未实装

**建议**
- 实装 cross-encoder reranker（bge-reranker-large）：对 query-doc pair 做语义相关性打分
- 能识别"共享单车 ↔ 哈啰"这种隐性相关
- 工程量：Python 服务 + 模型下载

**证据**：`data/rag/eval-results/eval-v3-2026-06-21.json`（failedQueries 11 条）

---

### P2-1：ground truth 升级为真实人工标注

**现状**
- 100 条 eval set 的 ground truth 是 doc id 占位：`groundTruthDocIds: ["travel_guides_北京_故宫", "travel_guides_北京_紫禁城"]`
- hit 判定 = chunk id 命中 groundTruthDocIds 任一
- 等价于关键词命中，不是真正 relevance judgment

**建议**
- 跑一次 V0 后导出每条 query 的 top-5 chunks
- 人工标注是否真的相关
- 用 `scripts/label-tool.ts` 替换 groundTruthDocIds 为真实 chunk ID

**证据**：`data/rag/eval-v1.jsonl`、`docs/rag-optimization-log.md` §3.2

---

## 二、数据源 / 降级链

### P0-4：业务校验进 FallbackDataSource

**现状**
- FallbackDataSource 触发条件只覆盖：主源返回空 / 主源抛错
- **业务校验完全缺失**：price=0 / price>100000 / 字段缺失不触发降级
- Zod schema 返回值校验弱：`Flight.price: z.number().nonnegative()` —— **0 元航班通过**

**问题**
- 两层断点：
  1. Zod 在 tool 入口校验 input，**不在数据源出口校验返回值**
  2. FallbackDataSource 只看 success / 数组长度，**不看业务字段**
- Amadeus 返回 5 个航班其中 3 个 price=0 → 系统照常返回，trace 记 fallbackLevel=0（"成功"），LLM 拿到含 price=0 的数据产生幻觉定价

**建议**
- 在 `FallbackDataSource.withFallback` 内部加 `validateBusinessData(method, results)`：

```typescript
if (method === "searchFlights") {
  for (const f of results) {
    if (f.price <= 0 || f.price > 50000) return { valid: false };
    if (f.durationHours <= 0 || f.durationHours > 24) return { valid: false };
  }
}
```

- 校验失败 goto fallback
- 延迟代价 < 0.1ms，可忽略

**证据**：`src/data-sources/fallback-data-source.ts:46-63`、`src/types/index.ts:44` (`Flight.price: z.number().nonnegative()`)

---

### P0-5：修 `executeToolsParallel` durationMs=0 硬编码 bug

**现状**
- 实测 804 个生产 tool_exec events，**durationMs>0 的有 0 个**
- 全员 0 的原因：`executeToolsParallel` 返回 `{ call, result, durationMs: 0 }` 硬编码

**问题**
- trace 完全无法用于"哪个工具慢"的延迟分析
- 可观测性短板

**建议**
- 修改 `agent-loop.ts:171-194` `executeToolsParallel`：

```typescript
const start = Date.now();
const result = await executor.execute(call, state);
return { call, result, durationMs: Date.now() - start };
```

- 5 行代码改动

**证据**：`src/runtime/agent-loop.ts:182`（`return { call, result: s.value, durationMs: 0 }`）、`data/trace/*.jsonl` 804 events 全 durationMs=0

---

### P0-6：写 fallback 比例监控脚本

**现状**
- 实测生产 trace 显示：

| 工具 | 调用数 | fallback 率 |
|---|---|---|
| plan_transit | 155 | **73%** ⚠️ |
| search_hotels | 67 | 15% |
| search_restaurants | 121 | 4% |
| search_attractions / xhs / flights | — | 0% ⚠️ 可疑 |

**问题**
- plan_transit 73% fallback 暴露高德 direction API 极不可靠（用户拿到的市内交通 73% 是 haversine 估算）
- 多个工具 0% fallback 可疑——可能是 fallback 触发条件太宽松（业务校验缺失）
- **没有 fallback 比例告警**——16% 整体降级率没触发任何告警

**建议**
- 写脚本扫 `data/trace/*.jsonl`，按 tool 输出 L0/L1/L2/L3 分布
- 设阈值：单个 tool fallback 率 > 30% 触发告警
- 上线监控

**证据**：`data/trace/` 28 个真实 session 文件

---

### P1-4：实装端到端混沌测试

**现状**
- 只有单元测试覆盖：主源空 / 主源抛错 / 主源+secondary 都失败
- `tests/integration/error-handling.test.ts:86-120` 三条 case

**问题**
- 生产真实故障模式没测：
  - 主源慢响应（5s+）
  - TLS 错误 / 证书问题
  - CDN 缓存毒化
  - 部分字段为空
  - 半死状态（50% 成功）
  - 限流（429）
  - 数据过期

**建议**
- 写混沌测试：mock 主源故意 timeout / 5xx / 部分字段缺失
- 验证 trace 完整链路（L0 timeout → L1 web_search → trace 显示 fallbackLevel=1）
- 加 CI（项目当前**没 CI**）

**证据**：`tests/integration/error-handling.test.ts`（只有 3 条基础 case）

---

### P1-5：主源健康检查短路

**现状**
- 每次请求都试 L0，失败才降级
- 没有主源 down 了直接跳 L1 的短路机制

**问题**
- 主源半死状态会浪费大量延迟（每次等超时再降级）

**建议**
- 实装主源健康检查：连续 N 次失败后标记 down，T 秒内直接跳 L1
- 类似熔断器模式

**证据**：`src/data-sources/fallback-data-source.ts:13-15`（每次都调 primary.searchXxx）

---

### P2-2：plan_transit 73% fallback 的产品决策

**现状**
- 73% 市内交通规划用 haversine 直线距离估算
- 用户拿到的"景点之间交通时间"73% 是估算值

**建议**
- 承认现状：简历/产品叙事改为"市内交通规划使用 haversine 估算作为主要方案，高德 direction 作为高精度可选"
- 或：换更可靠的市内交通 API

**证据**：trace 实测 plan_transit L0=42/L1=52/L2=61（fallback 率 73%）

---

## 三、Agent 编排层

### P0-7：Pipeline vs Agent Loop 对照评估不完全公平

**现状**
- `docs/mock-interview.md` 第 31-36 行宣称 Pipeline 胜出的三个原因：
  1. LLM 工具选择不稳定（漏调）
  2. ReAct 多轮累积延迟
  3. 上下文膨胀
- Pipeline 内 LLMPlanAgent 也用 ReAct（`agents/llm-plan-agent.ts:84-178`）

**问题**
- 对照不完全公平：
  - Pipeline 模式下 FlightAgent/HotelAgent 是直接代码调用，**LLM 不参与**（不可能漏调）
  - Agent Loop 模式下搜航班也变成 LLM 工具调用，**漏调是结构性风险**
  - 这种"不公平"恰恰是 Pipeline 设计目的，但不能说"Pipeline 一定优于 ReAct"
- Pipeline 内 LLMPlanAgent **没接 `TOOL_FALLBACK_CHAIN`**，用的是 agent 自己的工具循环——降级能力比 Agent Loop 弱
- Agent Loop **没有 checkpoint 续行**机制，Pipeline 有 `state.llmPlanCheckpoint`——超时恢复能力不对等

**建议**
- 给 Agent Loop 加同等的 checkpoint 续行机制
- 让 Pipeline 内 LLMPlanAgent 也接 `TOOL_FALLBACK_CHAIN`
- 在同一 query set 上跑，控制 LLM provider 端延迟
- 量化指标：漏调率 / 延迟 P50/P95 / LLM-as-Judge 质量分 / 降级触发比例

**证据**：`src/orchestrator/pipeline.ts`（Pipeline 用代码确定性调 FlightAgent/HotelAgent）、`src/agents/llm-plan-agent.ts:84-178`（内嵌 ReAct 但不接 TOOL_FALLBACK_CHAIN）

---

### P0-8：行程质量评测完全缺失

**现状**
- 项目评测覆盖：

| 层 | 实现 | 规模 |
|---|---|---|
| RAG 检索 | `rag/eval.ts` | 100 query / Hit@5=86% |
| 单元测试 | vitest | 216 条 |
| **行程质量** | **无** | **—** |

**没做**：
- ❌ LLM-as-Judge 给行程打分（覆盖度/合理性/多样性）
- ❌ 人工标注 golden plan 比对
- ❌ 端到端 query set 跑出来的 plan 质量评分
- ❌ Pipeline vs Agent Loop 在同一 query set 上的质量分对比

**建议**
- 搭 LLM-as-Judge（GPT-4 给双盲 plan 打分 1-5）
- 跑 50 条 query × 3 次取平均
- 这是简历最该补的一块

**证据**：项目无任何行程质量评测代码

---

### P1-6：状态机实际数量与简历叙事不符

**现状**
- ConversationState 实际 11 个：INIT / GATHERING_BASICS / GATHERING_PREFERENCES / SEARCHING_TRANSPORT / SELECTING_TRANSPORT / SEARCHING_HOTELS / SELECTING_HOTEL / SEARCHING / COMPLETED / ERROR_RECOVERABLE / ERROR_TERMINAL
- PlanningState 实际 7 个：COLLECTING_PREFERENCES / RECOMMENDING_DESTINATIONS / SEARCHING_PARALLEL / BUDGET_CHECKING / ADJUSTING / COMPLETED / FAILED
- 简历写"8 状态 FSM"

**建议**
- 简历改"11 状态对话 FSM + 7 状态 Pipeline FSM（两层叠加）"
- 或简化为"对话层 + 规划层双层 FSM 设计"

**证据**：`src/conversation/state-machine.ts:1-13`、`src/types/index.ts:27-35`

---

### P1-7：Pipeline vs Agent Loop 延迟数字站不住脚

**现状**
- `docs/mock-interview.md` 第 354 行：Pipeline ~20s，Agent Loop 40-60s
- 简历说"快 70%"（(60-20)/60 ≈ 67%）

**问题**
- **不是正式 benchmark**：
  - 没固定 query set
  - 没多次取平均
  - 没 P50/P95/P99 统计
  - 默认冷启动，热启动没测
  - 没控制 LLM provider 端波动（P95 经常是 P50 的 3-5 倍）
  - 没排除第三方 API 失败重试延迟

**建议**
- 写 benchmark 脚本：固定 20 条 query × 5 次冷启动 × 5 次热启动
- 输出 P50/P95/P99
- 简历改"快 70%"为"快约 2-3x（P50 延迟从 ~50s 降到 ~20s）"

**证据**：项目无 benchmark 脚本

---

### P2-3：重新评估 LLM 扩展路径

**现状**
- §9.6 "LLM 扩展路径的最终判定：废弃"——归因错误
- 真实原因：V5/V6 用 score-based 融合，IDF 稀释导致失败

**建议**
- 配合 P0-1 实装 RRF 后，重新跑 V5/V6
- 如果 RRF + LLM 扩展有效，§9.6 结论需要修正

**证据**：`docs/rag-optimization-log.md` §9.6

---

## 四、AsyncLocalStorage / Trace

### P1-8：ALS + Trace 双轨制统一

**现状**
- sessionLogger 走 ALS（`logging/session-context.ts`，传 sessionId）
- trace 系统走显式参数（`runtime/trace.ts:137`，每层方法签名加 `sid, iter`）

**问题**
- 同一份信息（sessionId）走两套传递机制
- trace 写入必须每层方法签名加 `sid, iter`，侵入性高

**建议**
- trace 也用 ALS（iter 改成显式参数因为它是局部状态）
- 或：保留双轨制，但承认是历史遗留

**证据**：`src/logging/session-context.ts` vs `src/runtime/trace.ts`

---

### P1-9：ALS 性能开销没测

**现状**
- 项目没针对 ALS 的 benchmark
- 业界数据（Node 18+ 优化后）：ALS 单次 enter/exit ~1-5μs

**建议**
- 写对照 benchmark：ALS vs 显式 sessionId 参数
- 整个 Pipeline 一次规划约 50-100 次 await 切换，理论 ALS 开销 < 1ms

**证据**：无 benchmark 代码

---

## 五、JSON 自修复

### P1-10：加 repairLevel 字段统计失败率

**现状**
- 实际是 4 层防御（简历说"三层"）：

| 层 | 实现 | 失败率 |
|---|---|---|
| L1 | extractOutermostBlock + JSON.parse + Zod | 未统计 |
| L2 | jsonrepair + Zod | 未统计 |
| L3 | simpleRepair（自写 regex）+ Zod | 未统计 |
| L4 | LLM 重试（maxRetries=3）| 未统计 |

**问题**
- trace 没区分"哪一层救回了"
- 无法评估各层有效性

**建议**
- trace 加 `repairLevel: 0|1|2|3|4` 字段
- 落盘统计各层通过率
- 简历改"三层"为"4 层（本地 3 层 + LLM 重试 1 层）"

**证据**：`src/tools/definitions/plan-schema.ts:87-120`、`src/runtime/agent-loop.ts:313-328`

---

## 六、`<thought>` 标签

### P1-11：简历叙事修正——thought 实际参与决策

**现状**
- thought 通过 `messages.push({ role: "assistant", content: respToAssistantContent(resp) })` 入 messages（`agent-loop.ts:262`）
- 下一轮 LLM call 时完整看到上一轮 thought（作为 text block）
- 跨轮喂回影响下一轮决策 = 标准 ReAct 循环

**之前错误描述**："thought 是审计用，不参与决策"

**建议**
- 简历叙事修正：thought 在当前轮内不影响控制流（同一轮 tool_use 已一次性输出），但**跨轮喂回影响下一轮决策**
- 跟 OpenAI Function Call 的本质区别不在循环结构（都是多轮），而在 **phase-gated tool policy + FSM 约束**

**证据**：`src/runtime/agent-loop.ts:214-311`（完整 ReAct 循环）

---

## 七、简历叙事修正清单（汇总）

| 简历原说法 | 真实情况 | 修正建议 |
|---|---|---|
| "8 状态 FSM" | 实际 11+7 两层 | "11 状态对话 FSM + 7 状态 Pipeline FSM" |
| "Pipeline 快 70%" | 没正式 benchmark | "P50 延迟约 2-3x（~50s → ~20s）" |
| "P95 115ms" | 115ms 是 avg，真实 P95 是 222ms | "avg 115ms / P95 222ms" |
| "自适应权重融合" | alpha 恒等于 0.6 | "二值切换的混合检索" |
| "JSON 三层防御" | 实际 4 层 | "4 层（本地 3 层 + LLM 重试 1 层）" |
| "8 条降级链" | 实际 10+4 | "10 条工具级 + 4 条数据源级" |
| "thought 不参与决策" | 跨轮喂回影响决策 | "ReAct 循环，thought 跨轮喂回" |
| "100 条 eval set" | 数字正确，但全是合成正面 case | "100 条合成 eval，无真实用户 query 无负面 case" |
| "Hit@5 86% 提升 +25pp 来自 V3 算法" | +25pp 主要来自数据 bug 修复 | "+25pp 来自数据清洗（city filter + PDF 噪声），V3 算法本身在 Hit@5 持平（MRR +1.8pp 显著）" |

---

## 八、最该立刻补的 P0 清单（按 ROI 排序）

1. **修 `executeToolsParallel` durationMs=0 硬编码**（5 行代码，让 trace 真能看延迟）
2. **加拒答阈值 + negative eval set**（防 negative case 误导 LLM）
3. **在 FallbackDataSource 加 `validateBusinessData`**（防 price=0 脏数据）
4. **实装 RRF**（30 行代码，验证 LLM 扩展是不是真的没用）
5. **写 fallback 比例监控脚本**（扫 trace 输出 L0/L1/L2/L3 分布）
6. **修 V3 city filter 严格相等 bug**（与其他两处对齐）
7. **搭 LLM-as-Judge 行程质量评测**（补简历最大短板）
8. **Pipeline vs Agent Loop 公平对照**（同 query set + 同等降级机制）

---

## 九、本次复盘的元反思

### 之前简历/对外叙事中的归因错误

| 错误归因 | 真实根因 |
|---|---|
| "V5 LLM 扩展 definitively 无价值" | IDF 稀释（融合方式错，不是扩展本身错）|
| "V3/V4/V5 修复后仍与 V0 相同 → 瓶颈在 embedding 召回" | 数据 bug（city filter + PDF 噪声）吃掉 20pp |
| "thought 不参与决策" | 跨轮喂回是标准 ReAct |
| "Pipeline 一定优于 ReAct" | 对照不公平（Pipeline 把确定性步骤代码化）|
| "P95 115ms" | 把 avg 当 P95 |
| "自适应权重" | 实际恒等于 0.6 |

### 元教训

1. **数字必须落盘**：口述数字（86% / 115ms / 70%）容易记错口径
2. **归因必须对照**：单 arm 实验得不出"A 比 B 好"的结论
3. **简历叙事要拆分**：算法贡献 vs 数据贡献 vs 工程贡献要分开讲
4. **生产 trace 是真相**：合成 eval 漂亮数字 ≠ 生产实际表现

---

**最后更新**：2026-06-26
**关联文档**：
- `docs/rag-optimization-log.md`（RAG 优化历史）
- `docs/mock-interview.md`（面试 QA）
- `progress.md`（项目交接）
