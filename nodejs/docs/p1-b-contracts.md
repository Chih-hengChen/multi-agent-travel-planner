# P1-B 接口契约

> 关联:`docs/agent-loop-redesign.md` §5 P1-B / `docs/rag-optimization-plan.md`
> 立项:2026-06-18
> 状态:**Hard contract** — P1-B 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:锁定 RAG 优化的交付物、评测指标、实验流程、与 Agent Loop 的集成方式

---

## 0. 文档定位

P1-B 的详细设计在 `docs/rag-optimization-plan.md`(已有)。本文档不重复那份方案,而是锁定交付物、指标目标、与 Agent Loop 的集成契约。详细实验矩阵见原计划。

---

## 1. 交付物清单

### 1.1 代码变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/rag-eval.ts` | 新建 | 评测脚本,支持 variant 配置化运行 |
| `scripts/rag-compare.ts` | 新建 | 多 variant 对比 + bootstrap 显著性检验 |
| `scripts/label-tool.ts` | 新建 | 交互式 ground truth 标注工具 |
| `src/rag/corpus-loader.ts` | 改 | 支持 chunk 策略切换 |
| `src/rag/rag-source.ts` | 改 | 支持 BM25/MMR rerank + query expansion |
| `src/tools/definitions/search-travel-guides.ts` | 改 | 支持 variant 参数传递 |

### 1.2 数据文件

| 文件 | 说明 |
|------|------|
| `data/rag/eval-v1.jsonl` | ≥100 条评测集(5 类 × 20) |
| `data/rag/eval-results/eval-{variant}-*.json` | 每次实验输出 |
| `data/rag/eval-results/comparison-*.md` | 对比报告 |
| `docs/rag-optimization-log.md` | 每个 variant 实验记录 |

### 1.3 指标目标

| 指标 | 基线 | 目标 |
|------|------|------|
| Hit Rate@5 | 71.8% | ≥85% |
| MRR | 未测 | ≥0.60 |
| NDCG@10 | 未测 | ≥0.55 |
| avg latency | 未测 | <200ms |
| eval set 规模 | 19 条 | ≥100 条 |

---

## 2. 实验流程契约

### 2.1 执行顺序

V0(Baseline) → V1(细粒度) → V2(粗粒度) → V3(Hybrid BM25) → V4(MMR) → V5(Query 扩展) → V6(重切分,必跑)

### 2.2 显著性判定

`delta >= 0.03 && pValue < 0.05`(bootstrap 1000 次,95% CI)。源:`docs/p0-a-contracts.md` §5.4。

### 2.3 chunk ID 稳定性

采用内容 hash(SHA-256 前 12 位)作为 chunk ID,V1/V2/V6 改 chunk size 后同名内容 ID 不变,ground truth 自动迁移。

---

## 3. 与 Agent Loop 集成契约

`search_travel_guides` 的返回格式在 P1-B 前后保持一致:

```ts
{ success: true, data: { guides: string } }
```

RAG 作为黑盒服务,Agent Loop 只关心工具返回了什么。variant 切换通过 `RAG_VARIANT` 环境变量控制,对 Loop 透明。

---

## 4. 测试计划

| 测试项 | 覆盖 |
|--------|------|
| eval set schema | Zod 校验 100 条全部合法 |
| chunk ID 稳定性 | 改 chunk size 后同名内容 ID 不变 |
| variant 切换 | `RAG_VARIANT` 环变控制生效 |
| rag-compare 报告 | 多 variant 对比表 + bootstrap CI |

---

## 5. P1-B step plan

1. eval set 扩展(LLM 合成 + 人工标注) → commit:`data: expand RAG eval set to 100 queries`
2. 评测脚本 → commit:`feat(scripts): RAG eval runner + label tool`
3. V1-V5 实验 + 记录 → commit:`docs: V1-V5 RAG experiment results`
4. V6 重切分 + 最终对比 → commit:`feat(rag): V6 re-chunking + final report`
5. 最优配置落地 → commit:`feat(rag): adopt best variant as default`

**P1-B 总估时**:5-7 天

---

## 6. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/rag-optimization-plan.md` | RAG 优化详细方案(权威源) |
| `docs/rag-optimization-log.md` | 实验记录 |
| `docs/agent-loop-redesign.md` §5 P1-B | 任务概要 |
| `nodejs/src/rag/` | RAG 源码 |
