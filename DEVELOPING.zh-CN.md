# 开发指南

如何运行、校验和扩展爬虫。使用数据请看 [README.zh-CN.md](README.zh-CN.md) · English: [DEVELOPING.md](DEVELOPING.md)

## 工作原理

1. `GET /api/v1/skills?per_page=500&page=N` —— 分页遍历排行榜(全站约 17 次请求)。只保留 GitHub 来源的条目(`sourceType: "github"`);well-known(域名)来源没有可归属的仓库,直接跳过并计入 `nonGithub`。
2. `GET https://api.github.com/repos/{owner}/{repo}` —— 获取每个去重后仓库的 `stargazers_count`(约 1200 次请求:大量技能共享同一仓库)。仓库 404(已删除)时该仓库的 `stars` 置为 `null`;其他失败则保留上一轮的值。
3. `GET /api/v1/skills/{source}/{skill}` —— 获取每个技能的文件(`files` 数组携带完整文本)。文件先写临时目录再原子重命名到位,因此「目录存在」就意味着「内容完整」。
4. 元数据合并成唯一的 `skills.jsonl` —— 每个已保存内容的技能一行,按 installs 降序,运行结束时原子写入。
5. 写入 `stats.json` —— 本次运行的统计,随数据集一起发布。只保留无法从其他字段直接推导的信息:

| 字段 | 含义 |
|---|---|
| `startedAt`、`finishedAt` | 运行的开始 / 结束时间(`durationMs` 即两者之差) |
| `limit`、`audits` | 运行配置(全量抓取时 `limit` 为 `null`) |
| `leaderboardTotal` | 去重后的 GitHub 来源排行榜条目数 |
| `nonGithub` | 因非 GitHub 来源被跳过的排行榜条目数 |
| `githubRepos` | 本次去重后抓取 star 的仓库数 |
| `indexedRows` | `skills.jsonl` 的行数 |
| `changed` | 本次内容版本发生变化的行数(首次抓取或上游 hash 变化)——恰好就是 `fetchedAt` 被重新打点的那些行 |
| `added`、`removed` | 进入 / 离开索引的技能数:上游新上榜的,以及已下架的(行与内容目录一并删除;仅全量运行——`--limit` 运行会把未评估的行原样保留) |
| `dropped`、`failed`、`carriedOver` | 各结果计数;`failedIds` 列出失败技能的 id |

## 前置条件

Node >= 22、Vercel OIDC token(任意 Vercel 项目均可)和 GitHub token(用于抓 star,仅有公开仓库读权限即可):

```bash
npm i -g vercel
vercel link && vercel env pull   # 将 VERCEL_OIDC_TOKEN 写入 .env.local,约 12 小时有效
echo 'GITHUB_TOKEN=ghp_…' >> .env.local   # 或自行 export GITHUB_TOKEN
```

OIDC token 过期后(HTTP 401)重新执行 `vercel env pull` 即可。切勿提交 `.env.local`。在 GitHub Actions 中,同一个 token 存为仓库 secret `GH_TOKEN` 并映射为同名环境变量 `GITHUB_TOKEN`(secret 名不允许以 `GITHUB_` 开头)——内置 `GITHUB_TOKEN` 限额为每仓库 1000 次/小时,不够约 1200 次 star 请求。

## 运行

```bash
node scraper.mjs                          # 全量抓取到 ./data(约 8400 + 1200 次请求,30–45 分钟)
node scraper.mjs --limit 20               # 只抓前 20 个技能(快速端到端验证;limit 之外的技能
                                          # 沿用上一轮的索引行,因此在已有数据集上运行也安全)
node scraper.mjs --out ./data             # 自定义输出目录
node scraper.mjs --audits                 # 同时抓取安全审计结果(请求量翻倍)
```

- skills.sh 限速 600 次/分钟,GitHub 认证 REST API 限速 5000 次/小时;脚本分别以 590 次/分钟和 80 次/分钟自限(共享并发 10),按 `Retry-After` 重试 `429` 和 `5xx` 及瞬时网络错误;`4xx` 一律不重试——它们是确定性的。
- 每次运行都全量重新下载并重写全部内容(约 8400 次 skills.sh 请求)。上次的 `skills.jsonl` 只用来固定 `fetchedAt`:上游 hash 未变化的技能保留「首次抓取该内容版本那一次运行」的 `fetchedAt`。中断重跑可续抓,上游内容变更会被自动跟进。
- star 数每次运行按去重后的仓库全量重抓(约 1200 次 GitHub 请求)。仓库请求失败的技能沿用上一轮的值(或 `null`);carried over 的行(抓取失败、`--limit`)同样沿用旧的 `stars`。仓库 404 时 `stars` 置为 `null`。
- 索引只包含 GitHub 来源且内容已落盘的技能:well-known(域名)来源在排行榜阶段即被跳过(计入 `nonGithub`);重复技能、上游无快照的技能不会出现在索引中(记录日志、计入 `Done:` 汇总、下次自动重试)。抓取失败的技能会沿用上一次的索引行和内容目录,镜像继续提供最后一份可用内容,且「行 ⟺ 目录」不变式不被破坏;从未成功抓取过的技能则不进索引。使用 `--limit` 时,limit 之外的技能同样沿用上一轮的索引行(limit 只约束抓取什么,不约束索引;下次全量运行会重新评估它们)。以上均计入 `carried over`。进程仅在系统性故障(鉴权、排行榜、索引写入)时以非零码退出。
- 使用 `--audits` 时,只对内容 hash 变化的技能重新抓取审计结果;hash 未变的技能直接沿用上一次的结果,不发请求。
- slug 规范化:上游的 slug 本身可能含 `/`(如 `claude-office-skills/skills/facebook/meta-ads`)。skills.sh 以 `${source}/${slug}`(slug 中的 `/` 去掉,如 `…/facebookmeta-ads`)作为这类技能的键——这是其详情 API 对多段 slug 唯一能寻址的形式。因此爬虫在去重之前,把每个 GitHub 来源条目的 id 规范化为 `${source}/${去斜杠的 slug}`(`lib.mjs` 中的 `canonicalId`);两个原始 id 理论上可能去斜杠后相同,此时保留先出现的那个。slug 本身不含 `/` 的 id(绝大多数)原样通过。

## 验证

| 层 | 回答的问题 | 依赖 | 命令 |
|---|---|---|---|
| 1. 离线测试 | 爬取逻辑是否正确? | 无(mock API) | `npm test` |
| 2. 产物校验器 | 数据集是否完整? | 无(不联网) | `node verify.mjs --out data` |
| 3. 真实 API 运行 | 线上接口行为是否未变? | token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` 是数据集被信任或上传前的门禁:每行可解析、id 唯一、按 installs 降序(并列时按 id 升序)、字段格式正确、无两行映射到同一目录名、索引行与磁盘目录双向严格对应(每行都有目录、无孤儿目录)、`stats.json` 存在且可解析并与索引一致、无 `.tmp` 残留。本地快速上手:

```bash
npm test                          # 快速,无需密钥
npm run scrape && npm run verify  # 全量抓取 + 完整性校验
```

## CI

- **`ci.yml`**(push / PR):层 1,跑在 Node 22 和 24 上。无需 secrets,fork 的 PR 也能运行。
- **`fetch-skills.yml`**(每日 18:00 UTC + 手动):先把上一份 `dist` 快照还原进 `data/`——其 `skills.jsonl` 里的上游 hash 用来固定 `fetchedAt`、沿用未变化的审计结果、保留抓取失败技能的上一次内容,并让 `changed`/`added`/`removed` 计数描述的是本次运行而非空工作区——然后全量抓取作为每日金丝雀 → `verify.mjs` → 强制推送每日提交到 [`dist` 分支](README.zh-CN.md#数据在哪里),历史只保留最近 5 个,并为窗口内的每个快照打 `dist-<日期>` 标签(标签名不含 `/`,以便在 raw URL 中解析;窗口外的标签会一并删除,被裁掉的提交因此保持不可达)。工作流用长效 `VERCEL_TOKEN` 现场换取新鲜 OIDC token(所需 secrets:`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`——后两项在 `vercel link` 后从 `.vercel/project.json` 复制);抓 star 读取仓库 secret `GH_TOKEN`(个人访问 token,映射为环境变量 `GITHUB_TOKEN`——用 `gh secret set GH_TOKEN` 配置)。
