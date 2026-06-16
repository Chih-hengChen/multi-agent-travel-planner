# RAG 优化方案

> 关联:`docs/agent-loop-redesign.md` §5 P1-B
> 立项:2026-06-16
> 状态:Plan,待 P1-B 启动
> 目标:把当前 19 条 eval set / Hit Rate 71.8% 扩到 100+ 条,通过 chunk/overlap/hybrid 多 variant 实验找到最优配置,Hit Rate 提升到 ≥85%

---

## 1. 现状基线(Baseline)

| 维度 | 当前值 | 来源 |
|------|--------|------|
| chunk size | 512 chars | `src/rag/corpus-loader.ts` |
| overlap | 80 chars | 同上 |
| chunking 策略 | `TravelDocStrategy`(## 标题切分 + 滑窗) | `corpus-loader.ts` |
| embedding 模型 | zhipu-3(2048 维) | `src/rag/embedder.ts` |
| 向量存储 | `MemoryVectorStore`(`data/vectors/travel_guides.json`,11MB) | `src/rag/vector-store.ts` |
| 关键词兜底 | 单字 + 双字 token,余弦 < 0.3 时触发 | `src/rag/rag-source.ts:60` |
| 相似度阈值 | 0.3 | `rag-source.ts:9` |
| 语料规模 | 129 PDF / 9,432 chunks | `progress.md` |
| eval set | 19 条 query | `data/rag/eval.jsonl`(待确认) |
| 指标 | Hit Rate@5 = 71.8% | `progress.md` |
| MRR / NDCG@10 | 未测 | — |

**问题**:19 条样本统计意义弱;MRR/NDCG 未测;chunk/overlap 没经过对比实验。

---

## 2. 评测集扩展到 100 条

### 2.1 配额(5 类 × 20 条)

| 类别 | 数量 | 示例 query |
|------|------|-----------|
| 景点(attraction) | 20 | "东京有什么必去的博物馆?" / "京都赏樱最佳地点?" |
| 美食(food) | 20 | "北京哪里有好吃的烤鸭?" / "成都最地道的火锅?" |
| 住宿(accommodation) | 20 | "东京亲子友好酒店推荐" / "三亚海景房 1500 以内" |
| 交通(transit) | 20 | "东京成田机场到市区怎么走?" / "北京地铁 24 小时票价格" |
| 综合(itinerary) | 20 | "东京 3 日亲子行程" / "西安文化 4 日深度游" |

### 2.2 合成流程

1. **LLM 合成候选**:按类别 × 城市(15 个)配额,每个组合 LLM 生成 5-10 条候选 query
   ```
   prompt: "为城市 {city} 生成关于 {category} 的真实旅行问题,
           要求自然语言、具体、可检索,避免空泛。
           输出 5 条,每条 < 30 字。"
   ```
2. **人工校验**:去除歧义、不合逻辑、与语料无关的;保留有 ground truth 的
3. **标注 ground truth**:从 9,432 chunks 中找最相关的 doc_id(每个 query 标 1-3 个正样本)
4. **版本化**:`data/rag/eval-v{N}.jsonl`

### 2.3 eval set schema

```jsonl
{
  "id": "q-001",
  "category": "attraction",
  "city": "东京",
  "query": "东京有什么必去的博物馆?",
  "groundTruthDocIds": ["chunk-1234", "chunk-5678"],
  "synthetic": true,
  "reviewer": "human-name",
  "version": "v1"
}
```

### 2.4 上线后持续替换

`/api/feedback` 收集真实 query → 每月评审 → 替换 10-20 条合成样本,版本号 +1。

---

## 3. 实验矩阵

每个 variant 只改一个变量,其他保持 baseline。

| ID | 名称 | 改动 | 假设 |
|----|------|------|------|
| B | Baseline | chunk=512, overlap=80, embedding=zhipu-3, no rerank | — |
| V1 | 细粒度 | chunk=256, overlap=30 | 提高召回精度,但可能上下文不足 |
| V2 | 粗粒度 | chunk=1024, overlap=100 | 提高上下文完整度,但可能稀释相关性 |
| V3 | Hybrid BM25 | chunk=512 + BM25 rerank | 中文关键词匹配强,补向量检索短板 |
| V4 | MMR 多样性 | chunk=512 + MMR(λ=0.7) | 减少冗余,提高结果覆盖度 |
| V5 | Query 扩展 | chunk=512 + LLM 扩展 query 为 3 个变体,合并检索 | 解决 query 表述差异问题 |
| V6 | 重切分 | TravelDoc 策略升级(按景点/美食/住宿切而非按 ## 标题) | 提高语义一致性 |

**预算**:每 variant 跑 1 次 + 失败重跑 1 次,共 ~12 次 eval。每次 ~3 分钟(9,432 chunks × 100 queries),总 ~1 小时。

---

## 4. 评测脚本设计

`scripts/rag-eval.ts`:

```ts
interface EvalConfig {
  variantId: string;            // "V1"
  chunkSize?: number;           // override baseline
  overlap?: number;
  embeddingModel?: string;
  rerankStrategy?: "none" | "bm25" | "mmr" | "query_expansion";
  chunkStrategy?: "travel_doc" | "by_section";
  evalSetPath: string;          // data/rag/eval-v1.jsonl
}

interface EvalResult {
  variantId: string;
  timestamp: string;
  config: EvalConfig;
  metrics: {
    hitRateAt5: number;         // 主指标
    hitRateAt10: number;
    mrr: number;                // Mean Reciprocal Rank
    ndcgAt10: number;
    recallAt5: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  perCategory: Record<string, { hitRateAt5: number; mrr: number; }>;
  perQuery: Array<{
    queryId: string;
    query: string;
    hits: string[];             // doc ids 返回的
    groundTruth: string[];
    hit: boolean;
    firstRank: number | null;
  }>;
  failedQueries: string[];      // 完全没命中的
}
```

**输出**:`data/rag/eval-results/eval-{variantId}-{YYYYMMDD}.json`

**对比脚本** `scripts/rag-compare.ts`:
- 读多个 EvalResult
- 输出对比表(`data/rag/eval-results/comparison-{YYYYMMDD}.md`)
- 自动找 stat sig(bootstrap 1000 次,95% CI)

---

## 5. 实验记录模板(`docs/rag-optimization-log.md`)

```markdown
## Variant V1: 细粒度(chunk=256, overlap=30)

**日期**:2026-MM-DD
**动机**:V0 baseline 在景点类 hit rate 仅 65%,怀疑是 chunk 太大,把多个景点塞一起稀释了相关性。

**配置差异**(vs baseline):
- chunkSize: 512 → 256
- overlap: 80 → 30

**指标对比**:

| 指标 | Baseline | V1 | Δ |
|------|----------|----|---|
| Hit Rate@5 | 71.8% | ?% | ? |
| MRR | ? | ? | ? |
| NDCG@10 | ? | ? | ? |
| avg latency | ?ms | ?ms | ? |

**按类别**:

| 类别 | Baseline Hit@5 | V1 Hit@5 |
|------|---------------|----------|
| attraction | ? | ? |
| food | ? | ? |
| ... | | |

**失败 query 分析**(V1 仍失败的):
- q-012 "北京地铁 24 小时票价格" — 0 hit
  - 原因:chunk 切太细,价格信息被切到另一个 chunk
  - Action:V2 试粗粒度

**结论**:[adopt / reject / iterate]
**下一 variant**:V2 粗粒度,验证上下文完整度假说
```

---

## 6. 优化决策树

```
Baseline (71.8%)
    │
    ├─ V1 细粒度(chunk=256)
    │   ├─ hit ↑ → adopt,进 V3 hybrid
    │   └─ hit ↓ → V2 粗粒度
    │
    ├─ V2 粗粒度(chunk=1024)
    │   ├─ hit ↑ → adopt,进 V3 hybrid
    │   └─ hit ↓ → chunk size 不是瓶颈,进 V3
    │
    ├─ V3 Hybrid BM25
    │   ├─ hit ↑ ≥ 5% → adopt,进 V4
    │   └─ hit ↓ → 中文 BM25 不 work,进 V4
    │
    ├─ V4 MMR 多样性
    │   ├─ hit ↑ → adopt
    │   └─ hit ↓ → 多样性不是瓶颈,进 V5
    │
    └─ V5 Query 扩展
        ├─ hit ↑ ≥ 5% → adopt
        └─ hit ↓ → 进 V6(重切分)

V6 重切分是兜底大改动,代价高,优先级最低
```

**目标**:至少找到 1-2 个 adopt,Hit Rate 从 71.8% → ≥85%。

---

## 7. 简历指标叙事模板

完成 P1-B 后,在 `docs/resume-highlight.md` 引用真实数字:

```markdown
### RAG 系统从 71.8% → X% 的优化

**起点**:71.8% Hit Rate(19 条 eval set,样本太小,统计意义弱)

**改进**:
1. 评测集从 19 条扩到 100 条(5 类 × 20 配额,LLM 合成 + 人工校验)
2. 设计 6 个 variant 实验(细粒度/粗粒度/hybrid/MMR/query 扩展/重切分)
3. 一次只改一个变量,跑基线对比,记录到 rag-optimization-log.md
4. Bootstrap 1000 次验证统计显著性

**结果**:
- Hit Rate@5:71.8% → X%(+Y%,95% CI [a, b])
- MRR:从无到有,达到 Z
- NDCG@10:从无到有,达到 W
- p95 latency:从 ?ms 优化到 ?ms

**关键学习**:[填实际发现,如"chunk=256 在景点类有效,但在综合类 hurt,采用混合策略"]
```

---

## 8. P1-B 执行步骤

| 步骤 | 估时 | 产出 |
|------|------|------|
| 1. 现状代码审计 + 确认 baseline 真实指标 | 0.5 天 | `rag-optimization-log.md` §Baseline |
| 2. LLM 合成 100 条 query | 0.5 天 | `data/rag/eval-v1-raw.jsonl` |
| 3. 人工校验 + 标注 ground truth | 1 天 | `data/rag/eval-v1.jsonl` |
| 4. 实现 `rag-eval.ts` 脚本 | 1 天 | 脚本 + 第 1 次基线跑 |
| 5. 实现配置切换(chunkSize/overlap/rerank) | 0.5 天 | RagSource 支持 variant |
| 6. 跑 V1-V6 实验 | 1 天 | 6 个 eval result |
| 7. `rag-compare.ts` + 决策 | 0.5 天 | comparison.md + adopt/reject |
| 8. 写进 resume-highlight | 0.5 天 | 简历可用 |

**总估时**:5.5 天。

---

## 9. 风险

### 9.1 LLM 合成 query 偏差
合成 query 可能过于"规整",与真实用户口语不一致。
**对策**:每月用真实 query 替换 10-20 条;eval set 版本化,跨版本对比。

### 9.2 Ground truth 标注主观
同一 query 可能多个 chunk 都相关,人工标注会漏标。
**对策**:每 query 标 1-3 个正样本;记录标注员;Hit Rate 容忍 ±5% 误差。

### 9.3 Embedding API 配额
6 variants × 100 queries = 600 次 embedding 调用,加上重切分要重 embed 整库(9,432 chunks)。
**对策**:embedder 已有 LRU 缓存;重 embed 一次成本 ~$1-2(zhipu-3 定价),预算内。

### 9.4 Baseline 指标复现困难
当前 71.8% 是 2026-06 测的,代码已变(AmapSource 加限流、Embedder 升级等)。
**对策**:P1-B 第 1 步先复现 baseline,作为后续对比锚点。

---

## 10. 与 redesign 主文档的对接

| redesign 引用点 | 本文档对应章节 |
|----------------|---------------|
| §3.2 工具 search_travel_guides | §1 baseline 配置 |
| §4.3 信息源 rerank(SOURCE_WEIGHTS) | §3 V3 Hybrid BM25 |
| §5 P1-B(5-7 天) | §8 P1-B 执行步骤 |
| §8 验收标准 #8(eval set ≥ 100) | §2 评测集扩展 |
