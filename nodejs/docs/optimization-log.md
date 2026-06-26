# Optimization Log

> 每次 prompt / 参数 / 工具定义变更的决策记录。
> 用途:数据飞轮的"最后一公里",让 patterns.md 的发现可追溯到具体的 prompt 修订。
> 关联:`docs/agent-loop-redesign.md` §4.4 数据飞轮 / `docs/prompt-versions/`

---

## 模板(每次变更复制一份)

```markdown
## [YYYY-MM-DD] 变更类型(prompt / 参数 / 工具)

**触发源**:
- [ ] patterns-{YYYY-MM}.md 的某条 pattern(引用 ID)
- [ ] 用户反馈(评分 ≤ 2 的 case)
- [ ] LLM 自评低分 case
- [ ] 主动优化

**变更内容**:
- 文件:`docs/prompt-versions/system-v{N}.md` → `system-v{N+1}.md`(路径与 redesign v2 §4.4 对齐)
- diff 摘要:[1-2 句描述改了什么]

**变更动机**:[为什么相信这个改动有效]

**A/B 测试结果**:
| 指标 | v{N}(基线) | v{N+1}(新) | Δ |
|------|-----------|------------|---|
| 自评均分(50 case) | ? | ? | ? |
| 用户评分均分 | ? | ? | ? |
| 行程完整度(dayPlans 覆盖率) | ?% | ?% | ? |
| 餐厅多样性分(本地特色比例) | ?% | ?% | ? |
| 预算偏差率(实际/预算) | ?% | ?% | ? |
| 平均工具调用次数 | ? | ? | ? |
| 平均 latency | ?ms | ?ms | ? |

> 注:JSON 解析失败率不应在此表 — 它由 `jsonrepair` + Zod 兜底,与 system prompt 无关,放在 P1-A 验收。

**决策**:[adopt / reject / iterate]
- adopt → v{N+1} 转 main,`prompts/system.md` 指向 v{N+1}
- reject → 回滚,记录失败原因
- iterate → 列出下一步要改的

**副作用**:[有没有意外影响其他 case]
```

---

## 已记录变更

(空,P0-A 启动后开始填)

---

## 索引

按时间倒序:

| 日期 | 变更 | 决策 |
|------|------|------|
| - | - | - |
