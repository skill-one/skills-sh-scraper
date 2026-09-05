# skills.sh 数据镜像

[skills.sh](https://www.skills.sh) 全站技能的每日更新镜像:排行榜元数据 + 完整文件内容。

English: [README.md](README.md) · 开发指南(运行 / 校验 / 扩展):[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## 数据在哪里

每日发布到 [`dist` 分支](../../tree/dist):每天一个提交,保留最近 5 个。每个提交都是完整快照——`skills.jsonl`(索引)+ `skills/`(全部技能文件):

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git   # 最新快照
git log dist                                                                      # 回看近期每日快照
```

也可以自己生成:`node scraper.mjs` —— 见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。

## 数据有哪些

```
data/
├── skills.jsonl   每个已保存技能一行,按 installs 降序 —— 查询 / 筛选 / 排行在这里
└── skills/        每个技能一个目录 —— 读文件 / 拷贝在这里
    ├── vercel-labs__skills__find-skills/     技能 id 中的 "/" → "__"
    │   └── SKILL.md
    └── mintlify.com__mintlify/              (GitHub: {owner}__{repo}__{slug} · well-known: {domain}__{slug})
        └── SKILL.md
```

技能目录里的文件与上游技能完全一致——整个目录可直接拷入 agent 的 skills 文件夹。索引与内容目录严格对应——有行当且仅当有目录——且「目录存在」就意味着「内容完整」。两者每次运行后都会做完整性校验。

`skills.jsonl` 每行包含 skills.sh 排行榜字段(`id`、`slug`、`name`、`source`、`sourceType`、`installs`、`installUrl`、`url`),以及爬虫添加的:

| 字段 | 含义 |
|---|---|
| `hash` | 技能文件内容的 SHA-256;未知时为 `null` |
| `fetchedAt` | 当前内容版本首次抓取的时间(hash 未变时沿用;内容本身每次运行都会重新下载) |
| `audits` | 使用 `--audits` 时:合作方审计结果(`provider`、`status`、`riskLevel`…);`[]` = 尚无人审计 |

不会进入索引的技能:重复技能(排行榜上的 `isDuplicate`)、上游无文件快照的技能、抓取失败的技能。每次运行都会重试它们,并在运行日志里计入 `dropped` / `failed`。

## 使用数据

```bash
cp -r data/skills/vercel-labs__skills__find-skills ~/.agents/skills/   # 目录即技能
grep -r "pattern" data/skills --include=SKILL.md                     # 全文检索
jq -s 'sort_by(-.installs)[:20] | map(.id)' data/skills.jsonl        # 安装量前 20
jq -c 'select(.audits[]?.status == "fail") | .id' data/skills.jsonl  # 未通过合作方审计
```
