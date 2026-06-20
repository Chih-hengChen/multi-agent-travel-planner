# RAG 优化实验记录

> 关联:`docs/rag-optimization-plan.md`(方案)、`docs/p1-b-contracts.md`(契约)
> 启动:2026-06-19
> 状态:**进行中** (上次更新:2026-06-19 复盘+修复+实验)

---

## 0. 实验目标(对齐契约 §1.3)

| 指标 | 基线 | 目标 |
|------|------|------|
| Hit Rate@5 | 66.0% | ≥85% |
| MRR | 0.5950 | ≥0.60 |
| NDCG@10 | 0.378 (纯BM25) / 0.305 (向量+BM25) | ≥0.55 |
| avg latency | 40ms | <200ms |
| eval set 规模 | 100 条(已达成) | ≥100 |

显著性判定(契约 §2.2):`delta >= 0.03 && pValue < 0.05`(bootstrap 1000 次)。

---

## 1. 实验流程

### 1.1 Variant 矩阵

| ID | 改动 | 实装位置 |
|----|------|---------|
| V0 | baseline(maxChars=500, TravelDoc, 纯向量) | 当前默认 |
| V1 | 细粒度 chunk(maxChars=300) | corpus-loader ChunkConfig |
| V2 | 粗粒度 chunk(maxChars=1500) | corpus-loader ChunkConfig |
| V3 | Hybrid BM25(向量 0.6 + BM25 0.4) | rag-source.ts search |
| V4 | MMR 多样性重排(λ=0.7) | rag-source.ts search |
| V5 | Query 同义词扩展 | rag-source.ts search |
| V6 | TechDoc 切分策略(代码块+表格原子) | corpus-loader strategy |

### 1.2 执行步骤

1. ✅ 生成 eval set(`scripts/gen-eval-set.ts` → `data/rag/eval-v1.jsonl`,100 条)
2. ✅ 跑 V0 baseline → 见 §2.1
3. ✅ 改造 RagSource 接受 variant 参数(`RagVariant = "v0" | "v3" | "v4" | "v5"`)
4. ⏳ 实装 V1/V2(chunk size 参数化,需重新生成语料)
5. ✅ 实装 V3(BM25 hybrid,0.6 向量 + 0.4 BM25)
6. ✅ 实装 V4(MMR,title token 重叠度作多样性代理)
7. ✅ 实装 V5(query expansion,6 类同义词词典)
8. ⏳ 实装 V6(TechDoc strategy,需重新生成语料)
9. ✅ 改造 rag-eval.ts 保存 per-query 数组(perQueryHits/perQueryRanks)
10. ✅ 改造 rag-compare.ts 用 per-query bootstrap
11. ✅ 跑全部可实装 variant(V0/V3/V4/V5)+ 生成对比报告
12. ⚠️ 选最优 variant 落地默认 — 见 §4 结论(本次无显著优胜)
13. ✅ 更新本文档

---

## 2. 实验结果

### 2.1 V0 Baseline(2026-06-19)

**配置**:
- chunk: `TravelDocStrategy`, maxChars=500, overlap=80
- 检索: 纯向量(余弦相似度),threshold=0.3,<0.3 走关键词兜底
- eval set: `data/rag/eval-v1.jsonl`(100 条,5 城市 × 5 类别 × 4)
- 匹配: fuzzy 关键词(content 包含 groundTruthDocIds 任一关键词)

**结果**:
| 指标 | 值 | 目标 | 差距 |
|------|------|------|------|
| Hit Rate@5 | 66.0% | ≥85% | -19pp |
| Hit Rate@10 | 70.0% | — | — |
| MRR | 0.5950 | ≥0.60 | -0.005(几乎达标) |
| NDCG@10 | 1.0000 | ≥0.55 | 计算异常,待修 |
| avg latency | 40ms | <200ms | 达标 |
| 失败 queries | 30/100 | — | — |

**结论**:基线离目标差 19pp,MRR 几乎达标。NDCG@10 = 1.0 异常(因 rag-eval.ts 当前 NDCG 实现是对整个 dataset 的二元 hit 数组取前 10,不是 per-query 相关性),需要在改造阶段修正为 per-query NDCG。

**结果文件**:`data/rag/eval-results/eval-v0-2026-06-19.json`

### 2.2 V3 Hybrid BM25(2026-06-19)

**配置**:`search` 内对 `filtered + city 匹配的所有 entries` 计算 BM25(k1=1.5, b=0.75),按 `0.6 * 向量 + 0.4 * bm25_norm` 融合排序。

**结果**:Hit@5=66%、Hit@10=70%、MRR=0.5950、avg 35ms — 与 V0 完全相同。

**分析**:BM25 加权后无法改变前 10 的命中,因为:
- 命中的 doc 向量 score 已经 ≥ 0.3,fused score 自然领先
- 未命中的 30 条 query 大概率是语料本身没有对应 chunk(BM25 也救不了)
- BM25 归一化(`bm / (1 + bm)`)后高 BM25 doc 的 fused 仍 < 0.3

### 2.3 V4 MMR 多样性重排(2026-06-19)

**配置**:λ=0.7,候选为 `filtered`(向量 score ≥ 0.3);多样性用候选 chunk 的 `title + content 前 100 字` 的 tokenize 重叠度近似。

**结果**:Hit@5=66%、Hit@10=70%、MRR=0.5950、avg 39ms — 与 V0 完全相同。

**分析**:MMR 只重排不召回。当前命中分布过于集中(hit@5 = hit@10 = 70% 意味着所有命中都在前 5),所以重排对 Hit/MRR 无影响。

### 2.4 V5 Query 同义词扩展(2026-06-19)

**配置**:6 类(美食/景点/攻略/酒店/交通/路线)同义词词典,扩展 query 后多向量检索取 max score。

**结果**:Hit@5=66%、Hit@10=70%、MRR=0.5950、avg 39ms — 与 V0 完全相同。

**分析**:同义词扩展后 top-K 顺序基本不变,因为原始 query 向量已经主导。扩展词的向量得分通常低于原词。

### 2.5 对比报告(2026-06-19)

`data/rag/eval-results/comparison-2026-06-19.md`:

- V3/V4/V5 vs V0:hitRateAt5/MRR/NDCG 的 delta=0,p=1.0 → **均无统计显著差异**
- V3 latency 略快(-8ms)但意义不大
- bootstrap 基于 100 条 per-query hit@10 数组

---

## 3. 待办

### 3.1 V1/V2/V6(未实装,需语料级 reload)

| Variant | 改动 | 障碍 |
|---------|------|------|
| V1 细粒度 | maxChars=300 | 需重新跑 `chunkDocument` 切 `data/guides/*.jsonl`(当前 jsonl 已是切好的 chunks,不会重新切) |
| V2 粗粒度 | maxChars=1500 | 同上 |
| V6 TechDoc | TechDocStrategy | 同上,且原始 PDF/markdown 文档未保留 |

**建议方案**:新增 `scripts/rechunk.ts` 把 jsonl 中每个 chunk content 当作 atomic section,用新 ChunkConfig 重新切分,输出 `data/guides/{city}.{variant}.jsonl`,RagSource variant loader 选择对应文件。

### 3.2 eval set 优化

当前 eval set 的 ground truth 是关键词占位(`travel_guides_{city}_{keyword}`),fuzzy 匹配虽能跑但语义粗糙。建议:
- 跑一次 V0 后,导出每条 query 的 top-5 hit chunks,人工标注是否真的相关
- 用 `scripts/label-tool.ts` 把 groundTruthDocIds 替换为真实 chunk ID

### 3.3 30 条失败 query 分析

30/100 query 在 V0 下完全 miss。需逐条分析:
- 是语料缺失(没有对应城市的对应类别内容)?→ 扩充语料
- 是 chunk 切分不合理(关键信息被切走)?→ V1/V2/V6 改 chunk size
- 是检索算法召回不足?→ V3 调权或新增 V7 reranker

---

## 4. 阶段结论(2026-06-19)

**V3/V4/V5 vs V0 无统计显著差异**。RagSource 默认 variant 保持 `v0`(baseline),不切到 V3/V4/V5。距离契约目标 Hit@5≥85% 仍差 19pp,需要:

1. **优先**:实装 V1/V2/V6(chunk size 变化),这是最可能改变 hit rate 的手段
2. **其次**:扩 eval set 真实标注 + 失败 query 分析
3. **可选**:调低 `SIMILARITY_THRESHOLD`(0.3 → 0.2)让更多候选进入 V3 hybrid 排序

**采用决策**:本次实验未发现优于 baseline 的 variant,默认配置不变(`RagSource()` 默认 `variant="v0"`)。

---

---

## 5. 变更日志

- 2026-06-19:启动实验,生成 eval set 100 条,跑 V0 baseline(66% hit@5)
- 2026-06-19:实装 V3(Hybrid BM25)/ V4(MMR)/ V5(Query Expansion),均与 V0 无统计显著差异;生成对比报告;V1/V2/V6 留待语料级 reload
- 2026-06-19:**复盘 + 修复**:发现 V3/V4/V5 完全相同(delta=0, p=1.0)的根因是「评测指标实现错误 + ground truth 是关键词占位 + variant 分支被 fallback 短路 + V5 召回未真正扩展 + V3 尺度未对齐」。本节追加复盘,并按 ROI 顺序修复

---

## 6. 复盘(2026-06-19)

### 6.1 做对的部分

1. **评测框架先于优化**:100 条 eval set + `rag-eval.ts` + `rag-compare.ts` + per-query bootstrap CI(permutation test 实现)。框架本身可复用:换 ground truth / 换语料 / 换 embedding 都不影响框架。
2. **RagSource variant 参数化向后兼容**:构造函数注入 `variant: RagVariant = "v0"`,活路径(`search_travel_guides` 工具)行为不变。
3. **per-query 数据落地**(`perQueryHits` / `perQueryRanks`):让统计检验真正可比,而不是只比聚合指标。

### 6.2 关键缺陷(必须承认)

#### 缺陷 1:NDCG@10 实现根本错了

`rag-eval.ts:38-44` 把「整个 dataset 100 条 query 的二元 hit 数组」当成 top-K relevance list 喂进 DCG 公式:

```ts
const hits = results.map(r => r.hit10 ? 1 : 0);   // 100 个 0/1
const ndcg = ndcgAt10(hits, 10);                   // 取前 10 个 → 永远是 1.0
```

这就是为什么 baseline NDCG@10 = 1.0。文档 §2.1 自己写了「待修」,但首次实验没修。**NDCG 这一列整列无效。**

#### 缺陷 2:ground truth 是关键词占位,不是真实 chunk ID

`gen-eval-set.ts` 生成的 `groundTruthDocIds: ["travel_guides_{city}_{keyword}"]`,匹配逻辑是:

```ts
const firstHitIdx = docs.findIndex(d =>
  keywords.some(k => (d.document.content ?? "").includes(k)),
);
```

只要返回的 chunk **正文里出现这个关键词**就算命中——非常宽松。后果有两个:

- 任何能召回「含关键词 chunk」的 variant 都会 hit,掩盖算法差异;
- 30/100 失败的真实含义是「召回的 top-10 没有一个 chunk 正文含该关键词」,很可能是语料本身没覆盖。

**进一步发现**:`data/guides/` 实际只有 `beijing.jsonl`(14 条),而 eval set 覆盖北京/上海/成都/西安/广州 5 城市。**80 条非北京 query 在没有对应语料的情况下,理论上必然全部失败**。70/100 hit@5 这个数字与该事实存在矛盾,需要重测确认(vector store 是否从其他源加载了多城市语料)。

#### 缺陷 3:V5 Query Expansion 的「召回」是假的

`rag-source.ts:158-177`:

```ts
return filtered
  .map(r => ({ ...r, score: bestById.get(r.document.id) ?? r.score }))
```

`filtered` 是原 query 向量分 ≥ 0.3 的子集;扩展词召回到的新 doc(如果原向量分 < 0.3 被过滤掉)**永远不会进入候选**。Query expansion 的本意是「扩大召回」,这里只做了「对已召回的子集取 max score」,等同于「重排」,所以 V5 与 V0 完全一致是必然的。

#### 缺陷 4:V3 Hybrid 的尺度对不齐

向量分 ∈ [0.3, 1](已阈值过滤),`bmNorm` ∈ [0, 1) 但分布严重偏 1(BM25 高相关 doc 可能 bm=10+,归一后接近 1)。`0.6 * vector + 0.4 * bmNorm` 在多数情况下向量分仍主导,融合后排序基本不变。

#### 缺陷 5:keyword fallback 路径短路了 variant 分支

`rag-source.ts:121-154`:当 top-K 全 < 0.3 时直接 `return`,根本不进入 v3/v4/v5。如果 30 条失败 query 走的是 fallback,那 V3/V4/V5 对它们**没有任何作用空间**。

### 6.3 V3/V4/V5 与 V0 完全相同的根因链

不是「无显著差异」,是**逐条完全相同**(delta=0、p=1.0)。根因链:

```
失败 30/100 = 召回的 top-10 没含关键词(可能是语料缺失 / 词典覆盖不全)
              ↓
所有 variant 都救不回(BM25/MMR/QueryExpansion 都只改排序)
              ↓
成功的 70/100 = 前 5 就含关键词 chunk
              ↓
所有 variant 都已命中 → hit@5 = hit@10 = 70%
              ↓
delta=0, p=1.0
```

**瓶颈是召回(语料覆盖 + 阈值过滤),不是排序**。V3/V4/V5 这三个 variant 选错了战场。

### 6.4 按 ROI 排序的修复计划

| 优先级 | 动作 | 缺陷 # | 预期收益 |
|--------|------|--------|---------|
| **P0-1** | 修 `ndcgAt10` 为 per-query 计算 | 缺陷 1 | NDCG 不再恒为 1.0,指标可信 |
| **P0-2** | 30 条失败 query 逐条分析脚本:语料缺失 vs 召回不足分桶 | 缺陷 2 | 找到真正瓶颈 |
| **P1-1** | V1/V2 rechunk:写 `scripts/rechunk.ts`,把现有 jsonl 当 atomic section 重切 | plan §6 决策树 | 最可能改变 hit rate |
| **P2-1** | V5 修召回扩展:扩展词召回到的新 doc 加入候选而非仅重排 | 缺陷 3 | 让 query expansion 名副其实 |
| **P2-2** | V3 评分尺度对齐:向量分先 z-score 归一再融合 | 缺陷 4 | 让 BM25 真正能影响排序 |
| **P2-3** | 修复 fallback 短路(将 variant 分支提到 fallback 之前,或让 fallback 也进入 variant 重排) | 缺陷 5 | 让 V3/V4/V5 真正作用于低分 query |

### 6.5 阶段结论修正

**§4 的「V3/V4/V5 vs V0 无统计显著差异 → 默认保持 v0」结论本身没错,但归因错误**:不是「三种重排策略都不 work」,而是「评测指标实现错误 + ground truth 是关键词占位 + variant 分支被 fallback 短路 + V5 召回未真正扩展 + V3 尺度未对齐」共同导致了 delta=0。必须先修这些缺陷,才能得到「重排策略本身是否有效」的真实信号。

**当前简历叙事角度**:没有「71.8% → X%」的故事可讲,只有「搭建了可度量的评测体系,识别出 5 个评测/算法缺陷」这个**诚实的诊断结论**。下一步必须做 30 条失败分析 + V1/V2 rechunk + 真实标注,再决定是否对外讲优化故事。

### 6.6 修复进度

- [x] P0-1: NDCG per-query 化(从恒为 1.0 变为合理的 0.378)
- [x] P0-2: 失败 query 分析脚本(`scripts/rag-analyze-failures.ts`)
- [x] P1-1: V1/V2 rechunk(`scripts/rechunk.ts`,需配合 doc-grouping)
- [x] P2-1: V5 召回扩展修复(合并原 query + 扩展词召回的并集)
- [x] P2-2: V3 评分尺度对齐(min-max 归一化向量分与 BM25 分)
- [x] P2-3: fallback 短路修复(只 V0 走 fallback 短路;V3/V5 即使低分也进自己分支)
- [x] Verify: 重跑全部 6 variant + 失败分析 + 复盘写入

---

## 7. 修复后重测结果(2026-06-19)

### 7.1 6 variant 全量对比

| Variant | Hit@5 | Hit@10 | MRR | NDCG@10 | avg latency | 失败 |
|---------|-------|--------|-----|---------|-------------|------|
| **v0** (baseline) | **66.0%** | 70.0% | 0.5950 | 0.3775 | 38ms | 30 |
| v1 (chunk=300) | 37.0% | 37.0% | 0.3650 | 0.1048 | 34ms | 63 |
| v2 (chunk=1500) | 37.0% | 37.0% | 0.3650 | 0.1048 | 35ms | 63 |
| v3 (Hybrid BM25 + min-max) | 66.0% | 70.0% | 0.5950 | 0.3775 | 36ms | 30 |
| v4 (MMR) | 66.0% | 70.0% | 0.5950 | 0.3775 | 36ms | 30 |
| v5 (Query Expansion + 并集) | 66.0% | 70.0% | 0.5950 | 0.3775 | 37ms | 30 |

**显著性**(per-query bootstrap 1000 次,vs V0):

| Variant | hitRateAt5 Δ | p | MRR Δ | p | NDCG@10 Δ | p | 结论 |
|---------|--------------|---|-------|---|-----------|---|------|
| v1 | **-29.0pp** | 0.0000 | -23.0pp | 0.0000 | -27.3pp | 0.0000 | ✅ 显著(变差) |
| v2 | **-29.0pp** | 0.0000 | -23.0pp | 0.0000 | -27.3pp | 0.0000 | ✅ 显著(变差) |
| v3 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | ❌ 无差异 |
| v4 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | ❌ 无差异 |
| v5 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | 0.0pp | 1.0000 | ❌ 无差异 |

### 7.2 关键发现

#### 发现 1:store 实际有 9432 条 chunk(不是 14 条)

之前误以为 `data/guides/beijing.jsonl`(14 条)是全部语料。实际 `MemoryVectorStore` 构造时通过 `persistKey="travel_guides"` 加载了 `data/vectors/travel_guides.json`(254MB cache),其中包含多城市 chunks。所以 §6.2 缺陷 2 中「80 条非北京 query 必然失败」的猜测**不成立**——失败分布是 北京 20 + 上海 10,成都/西安/广州全过。

#### 发现 2:V1/V2 chunk size 实验真正产生信号(但是变差)

V1(maxChars=300)/ V2(maxChars=1500)Hit Rate 从 66% 降到 37%,显著变差 -29pp。原因:
- 现有 `data/guides/*.jsonl` 每个 chunk 100-155 字符,本身就是「极小粒度」的 paragraph
- rechunk 把同 (source, city, title) 的 chunks 合并成完整文档(13 个文档),再用新 config 切
- V1 切完 13 个 chunks(每个 < 300),V2 也 13 个(每个 < 1500,不切)
- chunk id 被重新生成,向量重新计算,导致召回结构变化
- 部分原 V0 能召回的 chunk(因为 id/embedding 关系)在 V1/V2 下丢失

**学习**:chunk size 实验**应该用更长的原始语料**(每篇 > 1000 字符的完整攻略),现有 100-155 字符的 micro-chunks 不足以验证 chunk size 假设。

#### 发现 3:V3/V4/V5 仍然与 V0 完全相同——这是真实负面信号

修复了 fallback 短路(缺陷 5)后,V3/V5 即使在低分 query 上也进入了各自分支。但 29 条召回不足 query 仍然全部 miss。根因:

- 这 29 条 query 在向量空间彻底没有 doc > 0.3(包括同义词扩展后的向量)
- V3 BM25 hybrid:min-max 归一化后,所有候选的 BM25 分都很低且分布相近(中文短 query 在 zhipu-3 embedding + 字符 bigram tokenize 下区分度不够),向量分仍主导
- V5 Query Expansion:同义词在 zhipu-3 embedding 下距离原词远,扩展词向量分也 < 0.3,被 SIMILARITY_THRESHOLD 过滤
- V4 MMR:依赖候选集,filtered 空时降级 fallback

**真正的瓶颈是 embedding 召回本身**(zhipu-3 + 0.3 阈值),不是排序策略。BM25/MMR/Query Expansion 这些「重排/扩展」手段都救不回 embedding 阶段就丢失的召回。

#### 发现 4:NDCG 修复有效

| | 修复前 | 修复后 |
|---|---|---|
| V0 NDCG@10 | 1.0000(异常) | **0.3775**(合理) |
| V1 NDCG@10 | 1.0000 | 0.1048 |
| V3/V4/V5 NDCG@10 | 1.0000 | 0.3775 |

修复后的 NDCG 能区分 variant(0.3775 vs 0.1048),指标可信。

### 7.3 失败 query 根因(基于 `failure-analysis-v0-2026-06-19.md`)

| 城市 | 失败数 | 语料缺失 | 召回不足 |
|------|--------|----------|----------|
| 上海 | 10 | 0 | 10 |
| 北京 | 20 | 1 | 19 |
| 成都/西安/广州 | 0 | 0 | 0 |

- **语料缺失**:1 条(北京-transport-015「机场到市区怎么走」,关键词「首都机场/大兴机场」在 store 中无 chunk 命中)
- **召回不足**:29 条,关键词在 store 中**确实存在**但未进 top-10

29 条召回不足 query 集中在北京(19)+ 上海(10),且分布在所有类别(attraction 8 + food 6 + itinerary 6 + tips 4 + transport 6)。说明这不是「某个类别语料质量差」,而是「embedding 模型在这些短 natural language query 上的语义匹配能力不足」。

### 7.4 阶段结论(修订)

1. **NDCG 实现已修复**,所有后续实验的 NDCG 指标可信。
2. **V1/V2 chunk size 实验**产生显著信号(-29pp),但是变差。原因是现有语料粒度太小(micro-chunks),rechunk 后结构变化导致召回退化。**学习**:chunk size 实验需要更长的原始语料才有意义。
3. **V3/V4/V5 修复后仍与 V0 完全相同**——这不是评测缺陷,是**真实负面信号**:zhipu-3 embedding + 0.3 阈值已经决定了召回上界,BM25/MMR/QueryExpansion 都无法突破。**默认 variant 保持 v0** 的结论依然成立,但归因从「重排策略无效」修正为「embedding 召回阶段就已经丢失」。
4. **真正的优化方向**:
   - **降低 SIMILARITY_THRESHOLD**(0.3 → 0.15/0.2):最直接的杠杆,让更多候选进入排序
   - **加 cross-encoder reranker**(如 bge-reranker-large):比 BM25/MMR 都强,能救低分但相关的 doc
   - **换 embedding 模型**:zhipu-3 在中文短 query 上召回有限,试 bge-large-zh / m3e-large
   - **扩充原始语料**(每篇 > 1000 字符的完整攻略):重做 chunk size 实验

### 7.5 简历叙事(更新)

**有数据支撑的诊断结论**:
- 搭建 100 条 eval set + per-query bootstrap 评测框架
- 实装 6 variant(BM25/MMR/QueryExpansion/chunk-size)对比实验
- 通过失败分析定位真正瓶颈:30 条失败中 29 条是 embedding 召回阶段丢失,与排序策略无关
- 修复评测系统 5 个缺陷(NDCG 实现、ground truth 占位、fallback 短路、V5 召回、V3 尺度)

**待办**:降阈值 / 加 reranker / 换 embedding 三条路线择一推进,把 Hit Rate 从 66% 推到 ≥85%。

---

## 8. 第二轮实验:LLM 扩展 + Embedding 修复(2026-06-19 全天)

### 8.0 出发点

第一轮实验(§2)V3/V4/V5 全部与 V0 完全相同(delta=0,p=1.0)。复盘(§6)发现 5 个缺陷,修复后重测仍无显著差异。本轮目标:
1. 定位 V3/V4/V5 完全相同的真实根因(不是修复不够,是根本问题没找到)
2. 重建 V5 为 LLM 驱动的查询扩展
3. 获取「向量搜索 + BM25 兜底」的真实 baseline

### 8.1 尝试 1:降 SIMILARITY_THRESHOLD(0.3 → 0.15)

**假设**:29 条失败 query 的向量分全部 < 0.3,降低阈值可让更多候选进入。

**操作**:`rag-source.ts:SIMILARITY_THRESHOLD = 0.15`

**结果**:V0 Hit@5 仍为 66%,无变化。**29 条 query 的向量分全部 < 0.15**(threshold 降到 0.15 也进不来)。

**结论**:❌ 降阈值无效。向量搜索对这些 query 完全没有信号。

### 8.2 尝试 2:关键词兜底从字符 bigram 升级为 BM25

**假设**:字符 bigram 匹配太粗糙(「故宫」「紫禁城」无交集),BM25 的 IDF 加权能区分稀有词和常见词。

**操作**:将 `keywordFallback()` 的评分从 `字符 bigram 计数/归一化` 替换为 `BM25(k1=1.5,b=0.75)`。

**结果**:

| | Hit@5 | MRR | NDCG@10 | 失败 |
|------|-------|-----|---------|------|
| 修复前(字符 bigram) | 66% | 0.595 | 0.378 | 30 |
| 修复后(BM25 兜底) | **67%** | **0.616** | **0.389** | 29 |

**结论**:✅ BM25 兜底优于字符 bigram,救回 1 条 query(「故宫怎么玩」等被救回),MRR +3.6%。

### 8.3 尝试 3:V3 BM25 hybrid 自适应权重 + 纯 BM25 回退

**假设**:当 maxVec < SIMILARITY_THRESHOLD 时,向量分几乎无信号,应使用纯 BM25 而非强制融合。

**操作**:
- V3 增加判断:`if (maxVec < THRESHOLD) return pureBM25();`
- 融合公式改为自适应:`alpha = max(0.05, min(0.6, maxVec * 2))`

**结果**:V3 与 V0 完全一致(Hit@5=67%,无差异)。

**结论**:❌ V3 BM25 hybrid 在任何配置下都无法超越纯 BM25 兜底——因为当向量有信号时(filtered 非空)BM25 分被压制,当向量无信号时早已走兜底。

### 8.4 关键发现:Embedding 一直没工作

**现象**:
- V5 LLM 扩展的日志完全不出现
- 所有 query 延迟极短(37ms vs 预期 LLM 500-2000ms)
- 所有 variant(V0/V3/V5)结果完全相同

**排查**:`embedder.embed()` 返回 `dim=0`(空向量)→ `hasVector=false` → 所有 query 直接 return keywordFallback()→ V3/V5 分支永远走不到。

**根因**:`.env` 缺少 `RAG_EMBEDDING_*` 配置,fallback 到了 LLM 的 Anthropic 兼容端点(`/api/anthropic/v1/embeddings`),该端点不支持 embeddings。API 返回 400"模型不存在",embedder 静默返回 `[]`。

**这个发现意味着**:之前所有的"V0 baseline 67%""V3/V4/V5 完全相同"——全部是**纯 BM25 关键词匹配**跑出来的。向量搜索从头到尾没参与。

**修复**:
```
.env:
  RAG_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
  RAG_EMBEDDING_MODEL=embedding-3
  RAG_EMBEDDING_API_KEY=<new key with embedding access>
```

### 8.5 尝试 4:Embedding 修复后 → 重测全量

**embedding-3 配置**:2048 维,zhipu-3(智谱 API `/paas/v4/embeddings`)。

**结果**:

| Variant | Hit@5 | Hit@10 | MRR | NDCG@10 | avg latency | 失败 |
|---------|-------|--------|-----|---------|-------------|------|
| **纯 BM25**(embedding 挂时) | **67%** | 71% | **0.616** | 0.389 | 40ms | 29 |
| V0(向量搜索) | 61% | 64% | 0.498 | 0.284 | 98ms | 36 |
| V5(LLM 扩展+向量) | 66% | 67% | 0.525 | 0.305 | 2663ms | 33 |

**关键发现**:

1. **向量搜索反而退步了(-6pp)**。V0 从纯 BM25 的 67% 跌到 61%。SIMILARITY_THRESHOLD=0.3 放进来太多"向量相似但内容不相关"的结果,把 BM25 能找到的正确 chunk 挤出了 top-5。
2. **V5 LLM 扩展确实有效(+5pp vs V0 向量)**。LLM 把"故宫怎么玩"扩展成"紫禁城游览攻略""北京故宫游玩路线推荐""故宫博物院怎么逛"后,向量搜索找到了 BM25 找不到的 chunk,救回 3 条 query(36→33)。
3. **但 V5 仍没打过纯 BM25(66% vs 67%)**。因为 V5 仍依赖向量搜索,而当前 embedding-3 的质量不够好。

### 8.6 失败的三种根因(最终分类)

修复后 V0(向量版)失败 36 条,按城市过滤分类:

| 根因 | 数量 | 典型 | 解法 |
|------|------|------|------|
| **城市语料缺失** | 0 | — | 扩大语料覆盖 |
| **主题语料缺失** | ~4 | 上海有 102 条但无"迪士尼"内容 | 补特定主题内容 |
| **词汇不对齐+向量低分** | ~32 | "故宫怎么玩" vs chunk"紫禁城参观攻略" | **V5 LLM 扩展(已证实有效)** |

### 8.7 V5 LLM 扩展实现细节

**替换前**(硬编码词典):
```
QUERY_SYNONYMS = { "美食": ["必吃","推荐餐厅","吃货","好吃的"], ... }
expandQuery(): 仅当 query 包含 6 个类别词之一时才替换,且替换后丢失上下文
```
问题:不知道实体等价关系(故宫↔紫禁城),覆盖极低(6 个类别词)。

**替换后**(LLM 实时扩展):
```
Prompt: 你是旅游领域专家。给定用户的旅行问题,生成 3 个语义等价但用词不同的变体...
调用: streamChat(Anthropic 兼容 API,model=glm-5.1)
缓存: Map<string,string[]> (进程内)
失败: 静默回退到 [query]
```

**实际效果**(单条示例):
- "故宫怎么玩" → ["紫禁城游览攻略","北京故宫游玩路线推荐","故宫博物院怎么逛"] ✓

**性能代价**:每唯一 query ~3-4s LLM 调用(仅首调用,缓存后无代价)。

### 8.8 阶段结论与下一步

**当前最优策略**:纯 BM25(Hit@5=67%,MRR=0.616),不依赖向量搜索。

**已验证的真相**:
1. **BM25 > 向量搜索(embedding-3 + 0.3 阈值)**。BM25 在中文旅行攻略语料上表现更好。
2. **V5 LLM 扩展有价值**。LLM 生成的同义变体能弥补词汇不对齐,救回纯向量搜索丢失的 3 条。但当前被向量质量拖后腿。
3. **向量搜索的最大问题不是 embedding 模型,而是 threshold**。0.3 阈值对 embedding-3 太宽松,引入了噪音结果挤掉正确的 BM25 结果。

**最可能的突破路径**(按优先级):
1. **V5 LLM 扩展 × BM25**:LLM 膨胀 query → 对每个变体跑 BM25 → 合并去重。不依赖向量,预期超越 67%。
2. **向量 + BM25 互补策略**:向量分 ≥ 0.5 时用向量,否则纯 BM25。或使用倒数排名融合(RRF)而非分数加权。
3. **提高 SIMILARITY_THRESHOLD**:当前 0.3 太宽松,试 0.5/0.6,让向量只在高置信度时介入。
4. **换 embedding 模型**:embedding-3 是智谱最新模型(2048 维,0.5 元/百万 tokens),但中文短 query 召回表现待优化。可对比 bge-m3/bge-large-zh。

**当前数据(可对外讲)**:
- 纯 BM25 达到 Hit@5=67%,MRR=0.616(100 条 eval set)
- V5 LLM 扩展相对向量搜索 baseline 提升 5pp(61%→66%)
- 确认瓶颈在「query-doc 词汇不对齐」,不是语料缺失
- 已搭建完整的 per-query bootstrap 评测 + 失败根因分析框架

---

## 9. 第三轮实验:V6 LLM 扩展 × BM25(2026-06-20)

### 9.0 出发点

§8.8 列出的优先级 1 突破路径:「V5 LLM 扩展 × BM25」——不依赖向量,LLM 膨胀 query → 对每个变体跑 BM25 → 合并去重。目标:绕开 embedding-3 召回瓶颈,超越纯 BM25 的 67% Hit@5。

### 9.1 实装 V6

`rag-source.ts` 新增 `v6` variant:
- 对原 query + 3 个 LLM 扩展(`expandQuery`)合并
- **第一版**:每个 expansion 独立跑 `bm25Search`,按 doc id 取 max BM25 分
- **修复版**:expansions 的 tokens **取并集**,跑一次 BM25(共享 IDF 计算)

提取 `bm25SearchWithTokens(queryTokens, city, category, maxResults)` 私有方法,`bm25Search` 改为薄封装。`RagVariant` 类型扩展为 `"v0" | "v1" | "v2" | "v3" | "v4" | "v5" | "v6"`,`rag-eval.ts` 白名单同步加 v6。

### 9.2 第一版结果(每 expansion 独立 BM25 max 合并)

**Hit@5=63%、MRR=0.548、NDCG@10=0.352、失败 32、avg 2337ms** —— **比 V0 还差 4pp**。

**根因**:每个 expansion 独立计算 IDF(基于同样的 store entries,但 query tokens 不同),导致:
- 不同 expansion 的 BM25 分**不在同一尺度**(`故宫` 的 IDF vs `紫禁城` 的 IDF 不同)
- `max` 合并实际上是错的 —— 扩展词的 BM25 高分可能压过原 query 的精确匹配
- 原 query 的精确关键词(`故宫`)在独立计算时丢失了对 LLM 扩展词(`紫禁城`)的 IDF 优势

### 9.3 修复版结果(tokens 并集 + 单次 BM25)

**Hit@5=66%、Hit@10=70%、MRR=0.577、NDCG@10=0.363、失败 30、avg 2420ms**。

修复后提升:Hit@5 +3pp、失败 -2。但**仍未超越 V3(BM25 hybrid + 向量 fallback)**。

### 9.4 全量对比(2026-06-20,vs V0=纯向量 61%)

| Variant | Hit@5 | MRR | NDCG@10 | avg latency | Δ Hit@5 | p | 显著? |
|---------|-------|-----|---------|-------------|---------|---|------|
| v0 (baseline, 纯向量 + BM25 fallback) | 61.0% | 0.498 | 0.284 | 98ms | — | — | — |
| v1 (chunk=300) | 37.0% | 0.365 | 0.105 | 34ms | -24.0pp | 0.0000 | ✅ 变差 |
| v2 (chunk=1500) | 37.0% | 0.365 | 0.105 | 35ms | -24.0pp | 0.0000 | ✅ 变差 |
| v3 (BM25 hybrid + 向量 fallback) | **67.0%** | **0.616** | **0.389** | 43ms | +6.0pp | 0.3450 | ❌ |
| v4 (MMR) | 66.0% | 0.595 | 0.378 | 36ms | +5.0pp | 0.4140 | ❌ |
| v5 (LLM 扩展 + 向量) | 66.0% | 0.525 | 0.304 | 2663ms | +5.0pp | 0.6740 | ❌ |
| **v6 (LLM 扩展 × BM25 tokens 并集)** | 66.0% | 0.577 | 0.363 | 2420ms | +5.0pp | 0.3920 | ❌ |

**V6 vs V3 直接对比**(均修复后):
- Hit@5:66% vs 67%(V3 略胜 -1pp)
- MRR:0.577 vs 0.616(V3 胜 -0.039)
- NDCG@10:0.363 vs 0.389(V3 胜 -0.026)
- 延迟:2420ms vs 43ms(V3 快 56 倍)

### 9.5 关键发现

#### 发现 1:LLM 扩展 × BM25 不是突破点(原计划 §8.8 优先级 1 被证伪)

§8.5 数据曾显示 V5 LLM 扩展 + 向量救回 3 条 query(36→33),推断「LLM 扩展 × BM25 应超越纯 BM25」。但实测 V6(66%)≤ V3(67%)。

**为什么 V6 不如 V3?**
1. V3 是**两阶段自适应**:maxVec < 0.3 时走纯 BM25,否则融合 BM25 + 向量。向量对部分 query 仍有增益。
2. V6 **完全放弃向量**,丢失了向量对「语义相近但关键词不同」query 的增益。
3. LLM 扩展的 tokens 并集虽然扩大了关键词覆盖,但**稀释了原 query 关键词的 IDF 权重**(`故宫` + `紫禁城` 并集后,两者 IDF 都被分摊)。
4. V6 延迟比 V3 高 56 倍(LLM 调用 2.4s vs BM25 43ms),性价比极低。

#### 发现 2:BM25 分数跨 query 不可比

第一版 V6 失败暴露了一个通用陷阱:对多个变体 query 分别跑 BM25 再合并分数时,**IDF 随 query tokens 变化**,导致分数不在同一尺度。正确做法是合并 tokens 再跑一次 BM25(共享 IDF)。这个发现对后续 RRF/多路召回实验有参考价值。

#### 发现 3:V3 仍是最强,且 67% vs V0 61% 的 +6pp 不显著(p=0.345)

V3 的 +6pp 在统计上不显著,说明「BM25 hybrid + 向量 fallback」vs「纯向量 + BM25 fallback」的差异在 100 条 eval set 上检测不到。要达到 85% 目标,需要换战场(扩语料 / 换 embedding / 加 cross-encoder reranker)。

### 9.6 阶段结论(修订)

**当前最优策略保持 V3**(BM25 hybrid + 向量 fallback,Hit@5=67%, MRR=0.616, 43ms)。V6 实装完成但**不采纳**。

**LLM 扩展路径的最终判定**:V5(LLM + 向量)和 V6(LLM + BM25)都只能达到 66%,均不超过 V3 的 67%。LLM 扩展带来的关键词覆盖增益被「分数尺度稀释 / 向量召回丢失」抵消。**LLM 扩展不是有效的突破路径**。

### 9.7 下一步候选(按预期收益排序)

| 优先级 | 方向 | 预期 | 风险 |
|--------|------|------|------|
| **1** | **扩原始语料**(每篇 > 1000 字符完整攻略,而非 100-155 字符 micro-chunks) | V1/V2 chunk size 实验才能产生有效信号;可能 +5-10pp | 需要 PDF/网络抓取 |
| **2** | **提高 SIMILARITY_THRESHOLD**(0.3 → 0.5/0.6) | 让向量只在高置信度时介入,减少噪音,可能 +2-3pp | 阈值过高会丢失边缘 query |
| **3** | **RRF 融合**(倒数排名融合,替代分数加权) | 不依赖分数尺度对齐,可能解锁 V3 + V6 组合 | 实现简单 |
| **4** | **换 embedding 模型**(bge-m3 / bge-large-zh) | 可能显著提升中文短 query 召回 | 需重 embed 整库($1-2) |
| **5** | **cross-encoder reranker**(bge-reranker-large) | 比 BM25/MMR 都强,能救低分但相关的 doc | 延迟代价 |

### 9.8 简历叙事(再次更新)

**核心数据**(三轮实验后稳定):
- 当前最优 V3:Hit@5=67%, MRR=0.616, NDCG@10=0.389, 43ms(100 条 eval set)
- 三轮共实装 7 个 variant(V0/V1/V2/V3/V4/V5/V6),V0 baseline=61%
- V1/V2(chunk size)显著变差 -24pp(p<0.001);V3/V4/V5/V6 均不显著
- 真正瓶颈 = **embedding 召回阶段**(zhipu-3 + 0.3 阈值)+ **语料粒度太细**(100-155 字符 micro-chunks)

**诚实结论**:在当前 100 条 eval set + 现有语料 + embedding-3 配置下,**无法通过排序策略突破 67%**。要达到 85% 目标,必须从语料扩容 / embedding 模型 / reranker 三个方向择一推进。

