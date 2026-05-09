# 小澄 · Milestone 1

> **小澄** — 你的镜子，你的共修者。
> 用 AI 做脚手架的当代六时书。
>
> Smiling Tech 出品。

完整的产品设计 → [`docs/xiaocheng-design.md`](docs/xiaocheng-design.md)
小澄的灵魂 → [`fixtures/user-template/openclaw/SOUL.md`](fixtures/user-template/openclaw/SOUL.md)
数据模型规范 → [`docs/memory-schema-v1.md`](docs/memory-schema-v1.md)

---

## 这里是什么

里程碑 1：**多用户 worker 原型 + 内存验证 + 小澄人格层**。

最初的目标是验证："4G 内存的服务器，能不能撑 6 个 worker 进程？" 已通过——单 worker idle 状态 PSS ~62 MB，远低于 150 MB 预算。

Sprint 1.5 进一步加了 **provider 抽象**（大陆走 DeepSeek/Doubao，海外走 Anthropic）和**小澄人格层**（SOUL + 4 个 skill 模板 + memory schema 规范）。

---

## 当前结构

```
milestone-1/
├── worker/                    Worker 进程（Node 22 + ESM）
│   ├── worker.mjs              NDJSON 主循环、信号处理、turn 编排
│   ├── providers/              LLM 适配器
│   │   ├── anthropic.mjs       海外路径
│   │   ├── deepseek.mjs        大陆主推
│   │   ├── doubao.mjs          大陆备选
│   │   ├── index.mjs           懒加载注册表
│   │   └── types.mjs           契约文档
│   ├── provider-router.mjs     按 region/tier 选 provider+model（合规拦截）
│   ├── config-validator.mjs    白名单配置校验
│   ├── user-store.mjs          用户文件抽象（M3+ 可换分片实现）
│   └── quota.mjs               Token 预算追踪（dispatcher 是真理之源）
├── scripts/
│   ├── spawn-worker-bwrap.sh   bubblewrap 沙箱启动
│   └── measure-pss.sh          PSS 时序采样
├── harness/                   测试驱动
│   ├── driver.mjs / scenarios.mjs / measure.mjs / setup.mjs / worker-process.mjs
├── fixtures/
│   └── user-template/         新用户 seed 模板
│       └── openclaw/
│           ├── SOUL.md         ★ 小澄的灵魂（措辞守则）
│           ├── config.yaml
│           ├── prompts/        预留多 prompt 组合
│           └── skills/
│               ├── knowledge/SKILL.md   知识管家
│               ├── life/SKILL.md        生活助理
│               ├── study/SKILL.md       学习伙伴
│               └── fitness/SKILL.md     健身教练
└── docs/
    ├── xiaocheng-design.md     ★ 产品设计与哲学
    ├── memory-schema-v1.md     ★ 用户数据模型规范（v1 锁定）
    ├── milestone-1-design.md   原始 worker 内存验证设计
    └── decision-log.md         技术决策记录
```

## 前置依赖

- Linux + 内核 ≥ 4.18（`smaps_rollup` 需要）
- Node 22+（`/opt/node22/bin/node` 在测试机）
- `bubblewrap` (`apt-get install -y bubblewrap`)
- 至少一个 provider 的 API key（取决于你的 region）：
  - `DEEPSEEK_API_KEY` 大陆主路径（DeepSeek V3）
  - `DOUBAO_API_KEY` 大陆备选（火山引擎）
  - `ANTHROPIC_API_KEY` 海外路径

## 快速开始

```bash
cd milestone-1
npm install
export DEEPSEEK_API_KEY=sk-...

# 运行单场景
node harness/driver.mjs B    # 单 turn

# 运行全部场景
node harness/driver.mjs

# 切沙箱模式（M2 之前只保留 bwrap）
MODE=bwrap node harness/driver.mjs A B
```

报告写入 `reports/`。

## 手动测一个 worker

```bash
mkdir -p /tmp/milestone-1-data/users/u1
cp -r fixtures/user-template /tmp/milestone-1-data/users/u1

DEEPSEEK_API_KEY=$KEY ./scripts/spawn-worker-bwrap.sh u1 <<EOF
{"type":"init","user_id":"u1","region":"cn-mainland","tier":"free"}
{"type":"turn","request_id":"r1","input":"你好"}
{"type":"shutdown"}
EOF
```

## 五个场景

| 场景 | 测什么 | 阈值 |
|---|---|---|
| A | 冷启动 + 30s idle | peak PSS ≤ 150 MB |
| B | 单 turn | peak ≤ 250 MB |
| C | 20 轮长上下文 | growth ≤ 30 MB（无泄漏） |
| D | 6 worker 并发 | total peak ≤ 3.5 GB |
| E | kill 中途，新 worker 恢复 | resumed_turns 一致 |

## 已验证

- ✅ Worker bwrap 启动 + NDJSON 协议
- ✅ DeepSeek / Anthropic 适配器（流式 + 用量统计）
- ✅ Region 强制路由：大陆用户配 anthropic 在 init 直接拒绝（PIPL 合规线）
- ✅ 配置校验：路径穿越、超额 max_tokens、未知模型等
- ✅ Budget preflight：余额不足在 LLM 调用前拒绝
- ✅ 状态原子写入（每 turn）

## 还没做（Sprint 1.5 之后）

| 任务 | 当前状态 | 下一 sprint |
|---|---|---|
| Memory 注入 system prompt | schema 已定，wiring 未做 | Sprint 1.6 |
| Memory 后处理（fact 抽取） | schema 已定 | Sprint 1.6 |
| 时段调度器（六时书 nudge） | 未做 | Sprint 1.7 |
| WeChat 服务号 webhook | 未做 | Sprint 2 |
| 客服消息推回 | 未做 | Sprint 2 |
| Dispatcher + Queue | 未做 | Sprint 2 |
| 多模态（语音/图片） | 未做 | M2 |
| 周/月洞见生成 | 未做 | M2 |
| 内容审核 | 未做 | M2 |

完整路线图见 `docs/xiaocheng-design.md`。

## 商业边界（用户承诺）

- 所有用户数据**不参与任何模型训练**
- 用户随时可一键**导出** (JSON/Markdown/PDF) 或**删除**全部数据
- 大陆用户的对话内容**不出境**（强制走大陆 LLM provider）

---

© 2026 Smiling Tech. MIT License.
