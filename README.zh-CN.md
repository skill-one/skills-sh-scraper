# skills.sh 数据镜像

[skills.sh](https://www.skills.sh) 全站技能的每日更新镜像:排行榜元数据 + 完整文件内容。

English: [README.md](README.md) · 开发指南(运行 / 校验 / 扩展):[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## 数据在哪里

每日发布到 [`dist` 分支](../../tree/dist):每天一个提交,保留最近 5 个。每个提交都是完整快照,直接位于分支根目录——`skills.jsonl`(索引)+ `skills/`(全部技能文件);每个保留的快照同时会打上 `dist/<日期>` 标签(标签窗口与保留的 5 个提交一致):

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git            # 最新快照
git clone --depth 1 -b dist/2026-09-06 https://github.com/skill-one/skills-sh-scraper.git # 固定取某一天
git ls-remote --tags https://github.com/skill-one/skills-sh-scraper.git 'dist/*'          # 列出可用日期
git log dist                                                                              # 回看近期每日快照
```

也可以自己生成:`node scraper.mjs` —— 见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。

## 数据有哪些

```
├── skills.jsonl   每个已保存技能一行,按 installs 降序(并列时按 id 升序)—— 查询 / 筛选 / 排行在这里
├── stats.json     产出该快照那一次运行的统计 —— 条目数、变化数、失败明细
└── skills/        每个技能一个目录 —— 读文件 / 拷贝在这里
    ├── vercel-labs/skills/find-skills/     即技能 id,按 "/" 逐级一层目录
    │   └── SKILL.md
    └── mintlify.com/mintlify/              (GitHub: {owner}/{repo}/{slug} · well-known: {domain}/{slug})
        └── SKILL.md
```

本地运行时爬虫把上面的结构写进 `data/`(`node scraper.mjs`);在 `dist` 分支上则直接位于分支根目录。

技能目录里的文件与上游技能完全一致——整个目录可直接拷入 agent 的 skills 文件夹。索引与内容目录严格对应——有行当且仅当有目录——且「目录存在」就意味着「内容完整」。两者每次运行后都会做完整性校验。

`skills.jsonl` 每行只保留 skills.sh 排行榜中的 `id`、`installs`、`url`(其余排行榜字段是冗余的:id 已编码了 source 和 slug),以及爬虫添加的:

| 字段 | 含义 |
|---|---|
| `description` | 取自技能 `SKILL.md` 的 frontmatter;没有时为 `null` |
| `hash` | 技能文件内容的 SHA-256;未知时为 `null` |
| `fetchedAt` | 当前内容版本首次抓取的时间(hash 未变时沿用;内容本身每次运行都会重新下载) |
| `audits` | 使用 `--audits` 时:合作方审计结果(`provider`、`status`、`riskLevel`…);`[]` = 尚无人审计。内容 hash 未变时沿用旧结果,hash 变化时重新抓取 |

不会进入索引的技能:重复技能(排行榜上的 `isDuplicate`)、上游无文件快照的技能。抓取失败的技能会保留上一次的快照(索引行 + 内容目录)不变,直到某次运行重新抓取成功;从未成功抓取过的技能则不出现在索引中。以上技能每次运行都会重试。从排行榜消失的技能,其索引行与内容目录会被一并删除——仅全量运行;`--limit` 运行会把所有未评估的行原样保留。沿用上一轮索引的行计入 `carried over`:抓取失败的技能,以及(`--limit` 时)limit 之外、内容仍在磁盘上的技能。

`stats.json` 记录产出该快照的那一次运行(只保留无法从其他字段直接推导的信息):

| 字段 | 含义 |
|---|---|
| `startedAt`、`finishedAt` | 运行的开始 / 结束时间(`durationMs` 即两者之差) |
| `limit`、`audits` | 运行配置(全量抓取时 `limit` 为 `null`) |
| `leaderboardTotal` | 去重后的排行榜条目数 |
| `indexedRows` | `skills.jsonl` 的行数 |
| `changed` | 本次内容版本发生变化的行数(首次抓取或上游 hash 变化)——恰好就是 `fetchedAt` 被重新打点的那些行 |
| `added`、`removed` | 进入 / 离开索引的技能数:上游新上榜的,以及已下架的(行与内容目录一并删除;仅全量运行——`--limit` 运行会把所有未评估的行原样保留) |
| `dropped`、`failed`、`carriedOver` | 各结果计数;`failedIds` 列出失败技能的 id |

## 使用数据

```bash
cp -r skills/vercel-labs/skills/find-skills ~/.agents/skills/   # 目录即技能
grep -r "pattern" skills --include=SKILL.md                     # 全文检索
jq -s 'sort_by(-.installs)[:20] | map(.id)' skills.jsonl        # 安装量前 20
jq -c 'select(.audits[]?.status == "fail") | .id' skills.jsonl  # 未通过合作方审计
```
