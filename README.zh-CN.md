# skills.sh 数据镜像

[skills.sh](https://www.skills.sh) 全站 GitHub 来源技能的每日快照:排行榜以可查询的索引形式保存(`skills.jsonl`),同时附带每个技能的完整文件(`skills/`)。

English: [README.md](README.md) · 开发指南(运行 / 校验 / 扩展):[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## 数据是什么

```
├── skills.jsonl   每个技能一行,按 installs 降序 —— 查询 / 筛选 / 排行在这里
├── trending.json  trending 榜单中前 100 个 GitHub 来源 id,按榜单顺序
├── curated.json   官方精选技能的 id,按 owner 分组
├── stats.json     产出该快照那一次运行的统计(条目数、变化数、失败明细)
├── latest         最新 tag,一行 —— 读它就能 pin
└── skills/        每个技能一个目录,目录名即技能 id
    └── vercel-labs/skills/find-skills/   ({owner}/{repo}/{slug})
        └── SKILL.md
```

`skills.jsonl` 每行形如:

```json
{
  "id": "vercel-labs/skills/find-skills",
  "installs": 3263512,
  "stars": 1523,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "description": "Find and install skills for your agent from skills.sh",
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  "fetchedAt": "2026-09-05T08:26:00.682Z"
}
```

| 字段                    | 含义                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `id`、`installs`、`url` | 来自 skills.sh 排行榜(id 已编码 source 和 slug:`{owner}/{repo}/{slug}`)                 |
| `stars`                 | 所在 GitHub 仓库的 star 数(id 的前两段即仓库);仓库已删除或未知时为 `null`               |
| `description`           | 取自技能 `SKILL.md` 的 frontmatter;SKILL.md 中没有 `description` 的技能不会被镜像       |
| `hash`                  | 技能文件的内容版本:按路径不区分大小写排序,逐文件拼 `路径 + 0x00 + 字节 + 0x00` 取 SHA-256([上游的 `hash`](DEVELOPING.zh-CN.md#上游的-hash));未知时为 `null`      |
| `fetchedAt`             | 当前内容版本首次抓取的时间                                                              |
| `audits`                | 使用 `--audits` 时:合作方审计结果(`provider`、`status`、`riskLevel`…);`[]` = 尚无人审计 |

两条保证,每次运行后都会做完整性校验:

- 技能目录里的文件与上游技能完全一致——整个目录可直接拷入 agent 的 skills 文件夹。
- 索引与 `skills/` 严格对应:有行当且仅当有目录,且目录存在就意味着内容完整。

边缘情况(抓取失败、`--limit` 运行、技能下架)见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。

`trending.json` 是 trending 榜单中前 100 个 GitHub 来源技能的 id,按上游榜单顺序——下标即名次。`curated.json` 是官方精选名单,按 owner 分组:`data[]` 每项含 `owner` / `totalInstalls` / `featuredRepo` / `featuredSkill` 与 `skills`(id 列表),顶层为 `totalOwners` / `totalSkills` / `generatedAt`。

两者都用与索引相同的 id 形式,可直接 join 回 `skills.jsonl`;`curated.json` 不做来源过滤,因此可能含索引里没有的 id,且同一技能可出现在多个 owner 名下。

## 如何获取数据

由 [`fetch-skills.yml`](.github/workflows/fetch-skills.yml) 工作流每日发布到 [`dist` 分支](../../tree/dist)——每个提交都是分支根目录下的完整快照。

### 获取单个文件

无需克隆、无需认证。`dist` 始终是最新快照;换成 `dist-<日期>` 标签即可钉住某天(最新 30 天有标签):

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
latest=$(curl -s $BASE/dist/latest)
curl -sO $BASE/$latest/skills.jsonl                                    # 索引:每个技能一行
curl -sO $BASE/$latest/skills/vercel-labs/skills/find-skills/SKILL.md  # 按 id 取任意技能文件
```

`latest` 就是一行纯文本的标签(`dist-2026-09-11`)——按标签缓存,因为新的一天到来时,变的只有它。解析一律从 `dist` 取:raw 的约 5 分钟缓存就是最坏延迟,绕不过去;若改用 jsDelivr 取,那是 12 小时的分支缓存(浏览器里 7 天)。

### 克隆整份快照

一次拿到全部数据,适合离线使用:

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-mirror.git
```

要固定到某天,改为克隆 `dist-<日期>` 标签(最新标签的解析方法见上):

```bash
git clone --depth 1 -b "$latest" https://github.com/skill-one/skills-sh-mirror.git
```

快照由 GitHub Actions 发布——随时手动触发:`gh workflow run fetch-skills.yml`;也可以自己生成:`node scraper.mjs` —— 见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。
