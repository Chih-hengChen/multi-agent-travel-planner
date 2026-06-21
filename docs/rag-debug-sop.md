# RAG 实验调试 SOP

> 关联:`docs/rag-optimization-plan.md`(方案)、`docs/rag-optimization-log.md`(实验记录,§10 揭露 3 个数据 bug 的复盘)
> 立项:2026-06-21
> 状态:Active
> 目标:把"第一性原理检查清单"变成实验前后的强制 gate,避免在错误数据上做算法调优

---

## 0. 为什么需要这个 SOP

`docs/rag-optimization-log.md` §10 复盘揭露:前三轮全部 V0/V3/V4/V5 实验(共 6 个 variant × 100 query × 多次跑)建立在 3 个被忽略的数据 bug 之上:

1. **city 字段命名不一致**(成都 vs 成都攻略,严格 `!==` 过滤 → 成都 20 条全 0 命中)
2. **eval failedQueries 索引错位**(失败分布报告长期失真,成都失败永远不出现)
3. **PDF 噪声**(分页符/重复标题前缀占满 chunk)

后果:前 3 轮"V3/V4/V5 vs V0 delta=0,p=1.0"的归因"瓶颈在 embedding 召回"**部分错误**。真实瓶颈是数据 bug,修了之后 V0 直接到 86%。

**教训**:在测量系统/数据层不可信时,算法 variant 实验的全部产出都是噪声。SOP 把检查前置到每次实验之前。

---

## 1. 5 层 Harness(代码已实装)

### Layer 1:Pre-experiment Store Health Check(最高价值)

**脚本**:`scripts/verify-store.ts`

**何时跑**:`rag-eval.ts` 之前(每次 store 变更后必跑,如清洗/扩充语料后)

**做什么**:
- 统计 store 中所有 city 字段分布(top 10)
- 对 eval set 每个 city 检查 exact / fuzzy / normalized 三种匹配数
- 若 `exact=0 && fuzzy>0` → **throw BLOCKER,exit 1**
- 输出 city 匹配表(`北京: exact=97, fuzzy=97, OK` / `成都: exact=0, fuzzy=59, BLOCKER`)

**早期发现价值**:如果在第一轮实验前存在,成都 bug 会在跑第一条 eval 之前就被 throw,省掉 3 轮无效实验。

### Layer 2:Per-stratum Eval Output

**实装**:`scripts/rag-eval.ts` 末尾输出 byCity 表

**做什么**:eval 完成后强制打印

```
[Layer 2] 按城市分层(city / Hit@5 / 失败 / store entries):
  city            | Hit@5     | 失败    | store entries
  ----------------|-----------|---------|--------------
  西安            |  85% (17/20) |   3/20  | 73
  广州            |  85% (17/20) |   3/20  | 53
  北京            |  75% (15/20) |   5/20  | 75
  上海            |  75% (15/20) |   5/20  | 78
  成都            |   0% ( 0/20) |  20/20  |  0   ← 一眼看出异常
```

**早期发现价值**:从 V0 第一次跑开始,这张表会让"成都 0% + 0 entries"无法被人眼忽略,不需要 LLM 推理。

### Layer 3:Oracle Test(分离"语料覆盖"vs"检索算法"两个假设)

**实装**:`scripts/verify-store.ts` 内置

**做什么**:对每条 query,不用向量/BM25,直接全文扫描:

```
oracleHit = store.some(entry =>
  cityMatches(query.city, entry.metadata.city) &&
  query.keywords.some(k => entry.content.includes(k))
)
```

输出 `Oracle 覆盖率 = oracleHit / total`。

**RAG 第一性原理**:
```
Hit Rate = P(正确 doc 在 store 里) × P(能检索到 | 在 store 里)
```

- **oracle=false** → 语料覆盖问题(优化检索算法没有意义,应扩语料/修 eval set)
- **oracle=true, retriever=false** → 检索算法问题(值得做 variant 调优)

`docs/rag-optimization-log.md` §7.3 说"29 条召回不足,关键词在 store 中确实存在",oracle test 把这个人工结论变成**可重复验证的数字**。

### Layer 4:Invariant Assertions

**实装 A**:`scripts/rag-eval.ts` 末尾的 sanity check
- `NDCG@10 > Hit@10 + 0.01` → 报错"METRIC BUG"(违反基础不等式)
- 所有城市 Hit@5 完全相同 → warn"SUSPECT: city filter 短路或测量系统问题"

**实装 B**:`scripts/rag-compare.ts` 末尾的告警段
- 所有 variant 的 `hitRateAt5` / `mrr` / `ndcgAt10` 三项 delta 全为 0 → warn"SUSPECT MEASUREMENT SYSTEM",列出可能原因(city filter 短路 / fallback 绕过 variant / 指标实现 bug / store 数据问题)

**经验法则**:**"N 个 variant 全部产生相同指标"本身就是 invariant violation** —— 正常情况下不同算法不可能完全一致。它的出现应该触发对测量系统的怀疑,而不是继续设计 variant N+1。

### Layer 5:LLM 调试前置 Checklist(本文档 §2)

**实装**:本 SOP 文档。

LLM 在提交任何算法优化建议之前,必须显式回答 §2 的三个问题。任何一项回答"no"或"unknown",先调查那一项,再做算法优化。

---

## 2. LLM 调试前置 Checklist

**MANDATORY BEFORE ANY OPTIMIZATION**:

在提出任何算法层面的改动之前,必须显式声明:

1. **eval 指标实现是否已验证正确?**
   - NDCG@10 是 per-query 还是 global?(参考 §6.2 缺陷 1:NDCG=1.0 异常)
   - ground truth 是占位符还是真实 chunk ID?
   - 失败 query 的索引是否对齐?(参考 §10.1 Bug B)

2. **store metadata 是否与 eval set 字段一致?**
   - 已跑 `tsx scripts/verify-store.ts` 且无 BLOCKER?
   - city / category 字段命名是否一致?

3. **是否已跑 oracle test 确认正确 doc 在 store 里?**
   - Oracle 覆盖率 ≥ 目标 Hit Rate?
   - 如果 oracle=false 占多数,先扩语料/修 eval set,不要做算法 variant

**RULE OF THUMB**:**if N variants all produce the same metric, investigate the measurement system before designing variant N+1.**

---

## 3. 通用第一性原理 RAG 调试顺序

项目内的标准 SOP,从 Level 0(最便宜、最容易忽视)到 Level 4(最贵):

### Level 0:测量系统可信吗?

| 检查 | 工具 |
|------|------|
| metric 实现是否正确(NDCG per-query vs global) | `rag-eval.ts:40-49` perQueryNdcg |
| ground truth 是占位符还是真实 ID | `data/rag/eval-v1.jsonl` 字段 `groundTruthDocIds` |
| 失败 query 索引对齐 | `rag-eval.ts:130` flatMap 修复(§10.3) |
| Invariant violations 是否触发 | `rag-eval.ts` Layer 4 / `rag-compare.ts` Layer 4 |

### Level 1:数据层正确吗?

| 检查 | 工具 |
|------|------|
| Store health check:字段命名 vs eval set 字段名 | `scripts/verify-store.ts` Layer 1 |
| 按 city/category 的 store entry 计数 | `rag-eval.ts` byCity 输出 |
| Oracle test:正确 doc 能否被全文搜索找到 | `scripts/verify-store.ts` Layer 3 |

### Level 2:管道层正确吗?

| 检查 | 工具 |
|------|------|
| 向量是否真的被计算(embedding 配置) | `.env` 的 `RAG_EMBEDDING_*`(§8.4 复盘) |
| filter 是否正确执行(city/category) | `src/rag/vector-store.ts:47` + `src/rag/rag-source.ts:327`(§10.3 修复) |
| fallback 路径是否短路了 variant 分支 | `src/rag/rag-source.ts` 各 variant 分支(§6.2 缺陷 5) |

### Level 3:检索算法有效吗?

| 检查 | 工具 |
|------|------|
| BM25 / 向量 / hybrid 对比 | `rag-eval.ts v0/v3/v4/v5/v6` |
| threshold / reranker 调优 | variant 实装 + per-query bootstrap |

### Level 4:模型 / 语料是否是瓶颈?

| 检查 | 工具 |
|------|------|
| embedding 模型替换 | zhipu-3 / bge-m3 / bge-large-zh |
| 语料扩充 | 每篇 > 1000 字符完整攻略(非 100-155 字符 micro-chunks) |

---

## 4. 标准实验流程(推荐顺序)

```bash
# Step 1: 实验前 health check(必跑)
tsx scripts/verify-store.ts data/rag/eval-v1.jsonl data/vectors/travel_guides.json
# 期望: ✅ Store 健康检查通过
# 失败: ❌ BLOCKER — 必须先跑 rag-clean-store.ts 规范化 city

# Step 2: 跑 variant(必跑)
tsx scripts/rag-eval.ts v0 data/rag/eval-v1.jsonl
tsx scripts/rag-eval.ts v3 data/rag/eval-v1.jsonl
# 期望: 末尾输出 byCity 表 + Layer 4 invariant check 通过

# Step 3: 对比(必跑)
tsx scripts/rag-compare.ts data/rag/eval-results v0
# 期望: comparison-{date}.md 包含 delta/p 表 + Layer 4 sanity check

# Step 4: 若 comparison 报"SUSPECT MEASUREMENT SYSTEM"
# → 停止设计新 variant,回到 Level 0-1 排查
```

---

## 5. 历史教训摘要(从 §1-§10 复盘中提炼)

| 轮次 | 缺陷 | 揭露方法 | 修复 |
|------|------|----------|------|
| §6.2 缺陷 1 | NDCG@10 用整个 dataset 二元数组 | 复盘人工审阅代码 | per-query 计算 |
| §6.2 缺陷 2 | ground truth 关键词占位 | 失败分析人工比对 | 后续 label-tool |
| §6.2 缺陷 5 | fallback 短路 variant 分支 | 复盘人工审阅代码 | variant 分支前置 |
| §8.4 | embedding 静默返回空向量 | 延迟异常(37ms vs LLM 500ms+) | 配 RAG_EMBEDDING_* |
| §10.1 Bug A | city 命名不一致(成都攻略) | **用户实地观察 + verify-store** | city filter startsWith + clean-store |
| §10.1 Bug B | failedQueries 索引错位 | perQueryHits 反推 vs failedQueries | flatMap |
| §10.1 Bug C | PDF 噪声 | chunk content 抽样 | clean-store 清洗规则 |

**模式**:前 4 项是"代码 bug",后 3 项是"数据 bug"。数据 bug 更难发现,因为代码看起来运行正常,但输入是错的。Layer 1 + Layer 3 是针对数据 bug 的专门防御。

---

## 6. 维护

- **新增 variant 时**:在 `rag-eval.ts` 的 `validVariants` 白名单加 ID,跑前先过 `verify-store.ts`
- **新增 eval set 时**:跑 `verify-store.ts` 确认 city 全部有 exact 匹配
- **清洗/扩 store 后**:跑 `verify-store.ts` + 跑 1 个 variant(V0)确认 byCity 表所有城市都有 store entries
- **每次 resume RAG 优化工作**:先读本文档 §2 的 LLM Checklist,逐项回答
