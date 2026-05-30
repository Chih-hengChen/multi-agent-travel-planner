# 多智能体旅行规划服务（Node.js / TypeScript）

多智能体（Multi-Agent）演示项目：**顺序流水线（偏好 → 目的地）** + **并行检索（航班 / 酒店 / 活动，`Promise.allSettled`）** + **预算反馈循环（最多 3 轮）**。所有 Agent 使用 **Mock 数据**，不调用外部真实 API。

## 智能体一览

| Agent | 职责 |
|--------|------|
| PreferenceAgent | 校验并补全用户偏好（流水线首站，失败短路） |
| DestinationAgent | 从 Mock 城市池中选择目的地（多维加权评分） |
| FlightAgent | Mock 往返报价（价格 50% + 时长 30% + 中转 20%） |
| HotelAgent | Mock 酒店（随风格与轮次调整价格） |
| ActivityAgent | Mock 活动与日程聚合（morning / afternoon / evening 时段分配） |
| BudgetAgent | 费用汇总与渐进降级（活动 40% → 酒店 35% → 航班 25%） |

## 目录结构

```
nodejs/
├── src/
│   ├── types/index.ts          # Zod schemas + TS types + TravelPlanState
│   ├── config/settings.ts      # dotenv 配置
│   ├── agents/                  # 6 个 Agent + 抽象基类
│   ├── orchestrator/            # parallel / budget-loop / pipeline
│   ├── api/                     # Fastify REST 服务
│   ├── cli/                     # commander CLI
│   └── index.ts                 # 入口（默认 CLI）
├── tests/                       # Vitest 测试
├── package.json
└── tsconfig.json
```

## 环境要求

- Node.js **20+**
- npm

## 安装

```bash
cd nodejs
npm install --ignore-scripts
```

## 运行

### CLI

```bash
cd nodejs
npx tsx src/index.ts --budget 15000 --departure 上海 --start 2026-06-01 --end 2026-06-05 --style comfort --travelers 2
```

### API 服务

```bash
cd nodejs
npx tsx src/api/app.ts
```

默认监听 **:3000**。可通过 `.env` 文件调整：

| 变量 | 含义 | 默认 |
|------|------|------|
| `API_PORT` | 监听端口 | `3000` |
| `API_HOST` | 监听地址 | `0.0.0.0` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `LLM_PROVIDER` | LLM 模式 | `mock` |

## API 示例

### 健康检查

```bash
curl -s http://localhost:3000/api/health
```

### 生成行程

```bash
curl -s http://localhost:3000/api/plan \
  -H "Content-Type: application/json" \
  -d '{
    "budget": 15000,
    "departure_city": "上海",
    "start_date": "2026-05-01",
    "end_date": "2026-05-05",
    "travel_style": "comfort",
    "num_travelers": 2,
    "interests": ["美食", "博物馆"]
  }'
```

成功返回 `PlanSummary` JSON。若偏好不合法，返回 **400**。

### 完整状态

```bash
curl -s http://localhost:3000/api/plan/full \
  -H "Content-Type: application/json" \
  -d '{"budget":10000}'
```

## 构建

```bash
cd nodejs
npx tsc
node dist/index.js --budget 10000
```

## 测试

```bash
cd nodejs
npx vitest run
```

## 架构说明（面试可讲）

1. **黑板架构（Blackboard）**：各 Agent 读写同一份 `TravelPlanState`，由编排层控制执行顺序与并发边界。
2. **模板方法模式**：`BaseAgent.run()` 定义生命周期（日志 → execute → 错误捕获），子类只需实现 `execute()`。
3. **并行执行**：`Promise.allSettled` + 每个 Agent 单独超时（`Promise.race`），对应 Python `asyncio.gather(return_exceptions=True)`。
4. **预算循环**：`BudgetAgent` 作为裁判，未达标则在最多 3 轮内渐进降级（活动 → 酒店 → 航班），每轮按超支比例动态计算削减幅度。
5. **Zod 验证**：运行时 schema 验证 + 编译时类型推断，单定义同时服务 API 请求校验和 TypeScript 类型安全。

## 技术栈

- TypeScript 5.x (strict)
- Fastify 5 + @fastify/cors
- Zod（数据验证）
- pino（结构化日志）
- commander（CLI）
- Vitest（测试）
