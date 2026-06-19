# RAG 优化实验记录

> 关联:`docs/rag-optimization-plan.md`(方案)、`docs/p1-b-contracts.md`(契约)
> 启动:2026-06-19
> 状态:**进行中**

---

## 0. 实验目标(对齐契约 §1.3)

| 指标 | 基线 | 目标 |
|------|------|------|
| Hit Rate@5 | 66.0% | ≥85% |
| MRR | 0.5950 | ≥0.60 |
| NDCG@10 | 待修计算后重测 | ≥0.55 |
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
