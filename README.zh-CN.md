# skills.sh 爬取工具

将 [skills.sh](https://www.skills.sh) 上列出的所有技能 —— 排行榜元数据 + 每个技能的完整文件内容 —— 抓取并保存到本地。单文件、零依赖（Node >= 20），基于[官方 API](https://www.skills.sh/docs/api) 构建。

> English documentation: [README.md](README.md)

## 工作原理

1. `GET /api/v1/skills?per_page=500&page=N` —— 分页遍历排行榜（全站约 17 次请求）。
2. `GET /api/v1/skills/{source}/{skill}` —— 逐个获取技能详情（响应中的 `files` 数组携带每个文件的完整文本），写入纯净的技能目录。文件先写临时目录再原子重命名到位，因此「目录存在」就意味着「内容完整」。
3. 元数据（列表 + 详情 + 可选审计）合并成唯一的 `skills.jsonl` 索引，在每次运行结束时原子写入。

## 前置条件

API 要求携带 **Vercel OIDC token**，任意 Vercel 项目均可：

```bash
npm i -g vercel
vercel link        # 关联你任意一个 Vercel 项目
vercel env pull    # 将 VERCEL_OIDC_TOKEN 写入 .env.local（约 12 小时有效）
```

脚本优先从环境变量 `VERCEL_OIDC_TOKEN` 读取，其次从当前目录的 `.env.local` 回退读取。token 约 12 小时过期（返回 HTTP 401）—— 重新执行 `vercel env pull` 即可刷新。切勿提交 `.env.local`。

## 用法

```bash
node scraper.mjs                          # 全量抓取到 ./data
node scraper.mjs --limit 20               # 只抓取前 20 个技能（快速端到端验证）
node scraper.mjs --out ./data             # 自定义输出目录
node scraper.mjs --audits                 # 同时抓取安全审计结果（请求量翻倍）
node scraper.mjs --skip-duplicates        # 跳过 isDuplicate 副本的内容下载（元数据仍记录）
```

全量抓取约 8400 次详情请求；按 API 600 次/分钟的限速，预计 15–30 分钟（`--audits` 翻倍）。可安全重复执行：上次已抓取的内容会被复用，中断后重跑即续抓。单技能失败（如上游 id 异常）会记录在该行的 `error` 字段中，下次运行自动重试——进程仅在系统性故障（鉴权、排行榜、索引写入）时才以非零码退出。

## 产物结构

```
data/
├── skills.jsonl                              # 唯一元数据索引（每行一个技能，按 installs 降序）
└── skills/
    ├── vercel-labs/skills/find-skills/       # github 来源: owner/repo/slug
    │   ├── SKILL.md                          # 纯净技能文件——无任何杂质；整个目录
    │   └── scripts/run.sh                    #   可直接拷入 agent 的 skills 文件夹
    └── mintlify.com/mintlify/                # well-known 来源: domain/slug
        └── SKILL.md
```

`skills.jsonl` 单行示例（此处格式化展示）：

```json
{"id":"vercel-labs/skills/find-skills","slug":"find-skills","name":"find-skills","source":"vercel-labs/skills","sourceType":"github","installs":12345,"installUrl":"npx skills add vercel-labs/skills/find-skills","url":"https://skills.sh/vercel-labs/skills/find-skills","hash":"…","contentSaved":true,"fetchedAt":"2026-09-05T…","audits":[…]}
```

行字段：排行榜对象（`id`、`slug`、`name`、`source`、`sourceType`、`installs`、`installUrl`、`url`、可选 `isDuplicate`）加上：

| 字段 | 含义 |
|---|---|
| `hash` | 技能文件内容的 SHA-256（来自详情接口）；未知时为 `null` |
| `contentSaved` | `true` 表示技能文件已落盘于 `skills/` 下 |
| `noSnapshot` | skills.sh 上无文件快照时存在该字段（此时 `contentSaved` 为 `false`） |
| `fetchedAt` | 内容最近一次从 API 抓取的时间 |
| `audits` | 使用 `--audits` 时：合作方审计结果数组（`provider`、`status`、`riskLevel`…）；`[]` 表示尚无人审计 |
| `error` | 上次运行中该技能的详情请求失败时存在（如上游坏 id 导致的 `HTTP 400`）；下次运行自动重试 |

## 消费数据

```bash
# 安装技能到 agent——目录即技能
cp -r data/skills/vercel-labs/skills/find-skills ~/.agents/skills/

# 全技能全文检索
grep -r "pattern" data/skills --include=SKILL.md

# 排行 / 筛选
jq -s 'sort_by(-.installs)[:20] | map(.id)' data/skills.jsonl
jq -c 'select(.audits[]?.status == "fail") | .id' data/skills.jsonl
```

## 限速与错误处理

API 限制为每个 (team, project) 600 次/分钟。脚本以滚动窗口控制在 590 次/分钟、并发 10，并按 `Retry-After` 重试 `429`/`503` 响应及瞬时网络错误。

## 验证

三层验证，各自回答一个问题。本地与 CI 跑的是完全相同的命令。

| 层 | 回答的问题 | 依赖 | 命令 |
|---|---|---|---|
| 1. 离线测试 | 爬取逻辑是否正确？ | 无（mock API） | `npm test` |
| 2. 产物校验器 | 抓下来的数据集是否完整？ | 无（不联网） | `node verify.mjs --out data` |
| 3. 真实 API 运行 | 线上接口行为是否未变？ | Vercel OIDC token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` 按不变量校验数据集：JSONL 每行可解析、id 唯一、按 installs 降序、字段格式正确（`hash` 为 64 位 hex 或 null、`audits` 为数组等）、`contentSaved` 与磁盘目录严格对应、`noSnapshot` 行无内容、无 `_meta.json`/`.tmp` 残留。它是任何数据集被信任或上传前的门禁。

### 本地

```bash
npm test                                   # 快速，无需密钥
vercel link && vercel env pull             # 一次即可；token 约每 12 小时刷新
npm run scrape && npm run verify           # 全量抓取 + 完整性校验
```

### GitHub Actions

- **`ci.yml`**（push / PR）：层 1，跑在 Node 22 和 24 上。不依赖任何 secrets，fork 的 PR 也能运行。
- **`fetch-skills.yml`**（每日 02:00 UTC + 手动）：层 3，即每日金丝雀。它先用 secrets 现场换取新鲜的 OIDC token（OIDC token 约 12 小时过期，绝不能作为 secret 存储——只存长效的 `VERCEL_TOKEN`），先跑离线测试，再全量抓取，在真实数据上验证续抓（第二次运行必须 `saved=0`），然后运行 `verify.mjs`，全部通过才上传两个 artifact：`skills-jsonl-*`（索引）和 `skills-content-*`（完整镜像，保留 14 天）。

需要配置的仓库 secrets：`VERCEL_TOKEN`（Vercel 个人访问令牌）、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`——后两项在本地 `vercel link` 后从 `.vercel/project.json` 里复制。

## 说明

- 重跑语义：内容仅在技能目录不存在时抓取；元数据与审计每次运行都会用最新排行榜刷新。从 skills.sh 下架的技能会在下次运行时从 `skills.jsonl` 消失（其内容目录保留在磁盘上）。
- `--skip-duplicates` 仍会记录 `isDuplicate` 行（其他技能的 fork/复制）的元数据，只是跳过文件下载；之后去掉该参数重跑即可补齐。
- 无上游快照的技能标记为 `noSnapshot`，不会再重复请求。
- 路径段会做清洗（`.`/`..` → `_`，非 URL 安全字符 → `_`），确保 id 无法逃出输出目录。
- 本结构取代早期 v1 布局（`skills.json` 大数组 + 目录内 `_meta.json`），不再生成这些文件。
