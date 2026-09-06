# skills.sh 数据镜像

[skills.sh](https://www.skills.sh) 全站技能的每日快照:排行榜以可查询的索引形式保存(`skills.jsonl`),同时附带每个技能的完整文件(`skills/`)。

English: [README.md](README.md) · 开发指南(运行 / 校验 / 扩展):[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## 数据是什么

```
├── skills.jsonl   每个技能一行,按 installs 降序 —— 查询 / 筛选 / 排行在这里
├── stats.json     产出该快照那一次运行的统计(条目数、变化数、失败明细)
└── skills/        每个技能一个目录,目录名即技能 id
    └── vercel-labs/skills/find-skills/   (GitHub: {owner}/{repo}/{slug} · well-known: {domain}/{slug})
        └── SKILL.md
```

`skills.jsonl` 每行形如:

```json
{
  "id": "vercel-labs/skills/find-skills",
  "installs": 3263512,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "description": "Find and install skills for your agent from skills.sh",
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  "fetchedAt": "2026-09-05T08:26:00.682Z"
}
```

| 字段 | 含义 |
|---|---|
| `id`、`installs`、`url` | 来自 skills.sh 排行榜(id 已编码 source 和 slug) |
| `description` | 取自技能 `SKILL.md` 的 frontmatter;没有时为 `null` |
| `hash` | 技能文件内容的 SHA-256;未知时为 `null` |
| `fetchedAt` | 当前内容版本首次抓取的时间 |
| `audits` | 使用 `--audits` 时:合作方审计结果(`provider`、`status`、`riskLevel`…);`[]` = 尚无人审计 |

两条保证,每次运行后都会做完整性校验:

- 技能目录里的文件与上游技能完全一致——整个目录可直接拷入 agent 的 skills 文件夹。
- 索引与 `skills/` 严格对应:有行当且仅当有目录,且目录存在就意味着内容完整。

边缘情况(抓取失败、`--limit` 运行、技能下架)见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。

## 如何获取数据

每日发布到 [`dist` 分支](../../tree/dist)——每个提交都是分支根目录下的完整快照。两种取用方式:直接从 GitHub 获取单个文件,或克隆整份快照。

### 获取单个文件

无需克隆、无需认证。先从索引中筛选出目标 id,再按路径取技能的任意文件:

```bash
# 索引:每个技能一行,按 installs 降序——先过滤它找到目标 id
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills.jsonl

# 再按 id 取技能的任意文件:dist/skills/<id>/<文件名>
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills/vercel-labs/skills/find-skills/SKILL.md
```

GitHub 对这些 URL 有约 5 分钟的缓存,因此 `dist` 路径始终跟随最新快照。

要固定到某天,把 URL 中的 `dist` 换成 `dist-<日期>` 标签(最近 5 个快照有标签)。标签名刻意不含 `/`:raw URL 里的 `dist/<日期>` 会与 `dist` 分支产生歧义而无法解析。

```bash
# 解析出最新的可用标签,替换到上面任意 URL 里
latest=$(git ls-remote --tags https://github.com/skill-one/skills-sh-scraper.git 'dist-*' \
         | awk -F/ '{print $NF}' | sort -V | tail -1)
curl -sO "https://raw.githubusercontent.com/skill-one/skills-sh-scraper/$latest/skills.jsonl"
```

标签不可变,因此缓存友好:按标签缓存,只有出现更新的日期才需要重新拉取。

### 克隆整份快照

一次拿到全部数据,适合离线使用:

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git
```

要固定到某天,改为克隆 `dist-<日期>` 标签(最新标签的解析方法见上):

```bash
git clone --depth 1 -b "$latest" https://github.com/skill-one/skills-sh-scraper.git
```

也可以自己生成:`node scraper.mjs` —— 见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。
