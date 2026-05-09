# Memory Schema v1

> 一旦正式上线，**v1 schema 不再做不兼容变更**——用户数据是承诺。
>
> 升级走 schema versioning：v1 → v2 时通过迁移脚本，老用户文件保留 v1 备份。

---

## 总览

```
/data/users/{uid}/memory/
├── profile.json              # 用户画像（slow-changing）
├── preferences.json          # 偏好（slow-changing）
├── facts.jsonl               # 事实库（append-only）
├── timeline.jsonl            # 重要日期时间轴（append-mostly）
├── relationships.md          # 重要人物自由格式（用户可见可编辑）
├── intentions.jsonl          # 用户的愿望/目标
├── episodic.jsonl            # 跨时段会话摘要
└── liushishu/                # 六时书核心
    ├── entries/{YYYY-MM-DD}/{shi}.json
    ├── insights/
    │   ├── weekly/{YYYY-WW}.md
    │   ├── monthly/{YYYY-MM}.md
    │   └── annual/{YYYY}.md
    └── values.json           # 用户表达过的价值观（提取 + 用户确认）
```

### 写入原则

- **profile / preferences / values**：原子覆写（read-modify-write tmp + rename）
- **facts / timeline / intentions / episodic**：JSONL 追加，从不修改历史行
- **liushishu/entries**：每个时段一个文件，原子覆写
- **insights**：批处理任务生成，覆写

### 隐私约定

- **从不**包含其他用户的 ID
- **从不**包含明文的 OpenID / 手机号 / 身份证
- 用户随时可一键导出全部 / 删除全部
- 数据 **不参与任何模型训练**

---

## 1. profile.json

```typescript
type Profile = {
  schema_version: 1;
  preferred_name?: string;       // 用户希望被怎么称呼
  age_range?: '<18' | '18-25' | '26-35' | '36-45' | '46-55' | '>55' | null;
  pronouns?: string;             // "她"、"他"、"ta" 等用户自表述
  location_hint?: string;        // 城市/地区，用户自愿
  occupation_hint?: string;      // 自由文本，agent 提取
  interests: string[];           // 自由文本数组
  language_pref: 'zh-CN' | 'zh-TW' | 'en' | string;
  registered_at: string;         // ISO 8601
  last_active_at: string;
};
```

`profile.preferred_name` 优先级最高——agent 始终用这个名字称呼用户。

## 2. preferences.json

**重要**：这里**不写**任何医学/心理标签。

```typescript
type Preferences = {
  schema_version: 1;
  // 沟通偏好
  response_length: 'short' | 'medium' | 'long';   // 默认 short
  tone: 'plain' | 'gentle' | 'direct';            // 默认 plain
  
  // 时段偏好
  timebands: Array<{
    shi: 'mao' | 'si' | 'shen' | 'xu' | 'zi';
    enabled: boolean;
    trigger_at: string;           // "07:00" 等本地时
    style: 'minimal' | 'guided';  // 是否引导式提问
  }>;
  quiet_hours: { start: string; end: string };    // 不打扰
  
  // 节奏偏好（无医学标签）
  task_followthrough_pattern?: 'high-intent-low-completion' | 'balanced' | 'methodical';
  attention_style?: 'focused' | 'darting' | 'cyclical';
  
  // 关闭项
  proactive_nudges_enabled: boolean;
  weekly_insights_enabled: boolean;
};
```

## 3. facts.jsonl

```jsonc
// 每行一个 fact
{
  "id": "F-2026-05-09-001",
  "ts": "2026-05-09T16:32:11+08:00",
  "fact": "用户最近常说'切换任务太多'",
  "kind": "pattern",          // "pattern" | "event" | "preference" | "person" | "place"
  "confidence": "medium",     // "low" | "medium" | "high"
  "source": "turn:r-abc123" | "skill:knowledge" | "user:explicit",
  "decay": "stable" | "fading"  // 长期 vs 临时
}
```

读取时按 `decay` 和 `ts` 过滤——超过 90 天且 fading 的事实不再注入 system prompt。

## 4. timeline.jsonl

```jsonc
{
  "id": "T-2026-05-09-001",
  "ts": "2026-05-09T16:00:00+08:00",  // 记录时间，不是事件时间
  "event_date": "2026-12-25",          // 事件日期（可重复年份）
  "type": "birthday" | "anniversary" | "deadline" | "milestone",
  "who": "妈妈",
  "what": "生日",
  "remind_days_before": 3
}
```

## 5. relationships.md

自由格式 markdown。**用户可读可编辑**（通过 agent 协助）。例：

```markdown
# 我生活里的人

## 妈妈
- 退休教师，60 多岁，住老家
- 周一周三习惯下午打来电话
- 我提到的：上次回家时她膝盖疼

## 同事 W
- 我们在同一个项目组
- 我提到过：跟 W 沟通经常感觉被打断
```

## 6. intentions.jsonl

```jsonc
{
  "id": "I-2026-05-09-001",
  "ts": "2026-05-09T20:15:00+08:00",
  "intention": "学吉他",
  "milestone": "能完整弹一首歌",
  "started_at": "2026-05-09",
  "status": "active" | "paused" | "completed" | "abandoned",
  "last_action_ts": "2026-05-09T20:15:00+08:00"
}
```

`abandoned` 状态时 agent 不再主动提起——避免变成内疚源。

## 7. episodic.jsonl

```jsonc
// 每 N 个 turn 触发一次摘要
{
  "id": "E-2026-05-09-001",
  "ts": "2026-05-09T22:30:00+08:00",
  "turn_range": ["r-001", "r-008"],
  "summary": "用户聊到下午工作切换太多，想到要不要换工作。我们没有结论，记下了'实质投入'这个用户给自己提的问题。",
  "tags": ["work", "切换任务", "工作思考"],
  "emotion_note": "下行→平稳"
}
```

`emotion_note` 只是文字描述，不参与统计计算。

## 8. liushishu/entries/{YYYY-MM-DD}/{shi}.json

```jsonc
{
  "schema_version": 1,
  "ts": "2026-05-09T16:00:00+08:00",
  "shi": "shen",                              // mao|si|shen|xu|zi
  "elapsed_minutes": 8,
  "modality": ["text"],
  "raw_input": "工作了一下午...感觉好累",
  "structured": {
    "xing": ["回邮件", "改 PRD"],              // 行动
    "si": ["想是不是该换工作"],                 // 思考
    "qing": {                                   // 感受 - 用有限词集
      "energy": -2,                             // -2..+2
      "tags": ["疲惫", "迷茫"]                  // 从 emotion-vocab 选
    },
    "sheng": "意识到一直在切换，没有完整投入做一件事的时刻"  // 觉察（不是评判）
  },
  "agent_response": "...",
  "linked_facts": ["F-2026-05-02-3"],
  "linked_intentions": []
}
```

**`sheng` 字段绝对不存"我做错了"类内容**。如果用户说"我今天好废"，`sheng` 字段写的是"用户表达自我否定，agent 引导回到具体事实"。

## 9. emotion-vocab（情绪有限词集）

定义在 `~/.openclaw/emotion-vocab.json`（可被用户扩展）。M1 默认词集：

```json
{
  "schema_version": 1,
  "energy_axis": [-2, -1, 0, 1, 2],
  "tags": {
    "neutral": ["平静", "稳", "清"],
    "positive_low": ["轻盈", "舒展", "通畅"],
    "positive_high": ["开朗", "兴奋", "充实"],
    "negative_low": ["疲惫", "沉", "钝"],
    "negative_high": ["紧", "烦", "焦", "气", "委屈"],
    "complex": ["迷茫", "纠结", "混乱"],
    "body": ["饿", "困", "酸", "热", "冷"]
  },
  "user_extensions": []
}
```

**为什么用有限词集**（避免抑郁化）：

让用户从词集中选，而不是自由表达，能：
- 避免反复书写"我抑郁了"等强标签从而强化
- 给 LLM 提取后处理一个稳定的目标空间
- 让用户后续看到"模式"时，词集稳定意味着比较有意义

用户可以扩展 `user_extensions`，但只在自己的工作区生效。

## 10. liushishu/insights/

按周/月/年生成的 markdown。具体格式见 `docs/insights-format.md`（M2 写）。

## 11. values.json

```typescript
type Values = {
  schema_version: 1;
  // 用户在长期对话中表达过的、agent 提取并经用户确认的价值观
  expressed: Array<{
    text: string;                        // "工作要有实质感，不只是忙碌"
    first_appeared: string;              // ts
    reinforced_count: number;            // 被表达过几次
    user_confirmed: boolean;             // 用户是否明确"是的，我这么想"
  }>;
};
```

**用户未确认的，不算**。这是 agent 不能自作主张代替用户表达的地方。

---

## 注入策略（写给 worker.mjs）

每次 turn 开始，构造 system prompt 时注入：

| 文件 | 是否每次注入 | 容量上限 |
|---|---|---|
| SOUL.md | ✅ 每次 | 不限（但保持 < 5KB） |
| profile.json | ✅ 每次（轻量） | < 1KB |
| preferences.json | ✅ 每次（轻量） | < 1KB |
| facts.jsonl | 选最近 30 条 + 高 confidence + stable | < 3KB |
| timeline.jsonl | 选未来 7 天内的事件 | < 1KB |
| relationships.md | 提及当前对话相关人物时 | < 2KB |
| intentions.jsonl | 选 status=active | < 2KB |
| episodic.jsonl | 选最近 5 条 + 标签匹配 | < 3KB |
| liushishu/entries 今日 | 全部 | < 5KB |
| values.json | confirmed=true 的全部 | < 2KB |

**总注入预算**：< 25KB（约 6000 token），覆盖率 + cache 命中率平衡。

---

## 删除/导出协议

### 删除

用户说"清空我的全部记录"→ agent 二次确认 → 触发：
1. 备份当前 memory/ 到 `users/{uid}/memory.deleted.{ts}.tar.gz`（30 天后清除）
2. 删除 memory/ 全部文件
3. profile.json 重建为空
4. 通知用户："已清空。30 天内可联系管理员恢复。"

### 导出

用户说"导出我的全部数据"→ agent 询问格式：
- `JSON`：原始 schema，便于程序处理
- `Markdown`：人类可读，适合阅读和归档
- `PDF`：精装版，含洞见图表（需要 M2 渲染层）

打包为 `.zip` 上传至临时下载链接，24h 失效。

---

## 演进路径

**v2 候选**（不在 M1）：
- 加 emotion-vocab 的多语言版本
- 加 facts 之间的关联图（用户可视化"我反复在想什么"）
- 加 intentions 的依赖关系（A 完成才能开始 B）

**永不引入**：
- 任何医学/心理诊断标签
- 任何"善/恶"、"对/错"价值评判字段
- 任何用户排名/对比维度
