# 开发指南

如何运行、校验和扩展爬虫。使用数据请看 [README.zh-CN.md](README.zh-CN.md) · English: [DEVELOPING.md](DEVELOPING.md)

## 工作原理

1. `GET /api/v1/skills?per_page=500&page=N` —— 分页遍历排行榜(全站约 17 次请求)。
2. `GET /api/v1/skills/{source}/{skill}` —— 获取每个技能的文件(`files` 数组携带完整文本)。文件先写临时目录再原子重命名到位,因此「目录存在」就意味着「内容完整」。
3. 元数据合并成唯一的 `skills.jsonl`,按 installs 降序,运行结束时原子写入。

## 前置条件

Node >= 22 和 Vercel OIDC token(任意 Vercel 项目均可):

```bash
npm i -g vercel
vercel link && vercel env pull   # 将 VERCEL_OIDC_TOKEN 写入 .env.local,约 12 小时有效
```

过期后(HTTP 401)重新执行 `vercel env pull` 即可。切勿提交 `.env.local`。

## 运行

```bash
node scraper.mjs                          # 全量抓取到 ./data(约 8400 次请求,15–30 分钟)
node scraper.mjs --limit 20               # 只抓前 20 个技能(快速端到端验证)
node scraper.mjs --out ./data             # 自定义输出目录
node scraper.mjs --audits                 # 同时抓取安全审计结果(请求量翻倍)
node scraper.mjs --skip-duplicates        # 跳过 isDuplicate 的内容下载(元数据仍记录)
```

- API 限速 600 次/分钟;脚本以 590 次/分钟自限(并发 10),按 `Retry-After` 重试 `429`/`503` 及瞬时网络错误。
- 可安全重复执行:内容仅在目录不存在时抓取,中断后重跑即续抓;元数据与审计每次运行都刷新。
- 单技能失败记录在该行的 `error` 字段中,下次自动重试;进程仅在系统性故障(鉴权、排行榜、索引写入)时以非零码退出。

## 验证

| 层 | 回答的问题 | 依赖 | 命令 |
|---|---|---|---|
| 1. 离线测试 | 爬取逻辑是否正确? | 无(mock API) | `npm test` |
| 2. 产物校验器 | 数据集是否完整? | 无(不联网) | `node verify.mjs --out data` |
| 3. 真实 API 运行 | 线上接口行为是否未变? | token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` 是数据集被信任或上传前的门禁:每行可解析、id 唯一、按 installs 降序、字段格式正确、`contentSaved` 与磁盘目录严格对应、无 `.tmp` 残留。本地快速上手:

```bash
npm test                          # 快速,无需密钥
npm run scrape && npm run verify  # 全量抓取 + 完整性校验
```

## CI

- **`ci.yml`**(push / PR):层 1,跑在 Node 22 和 24 上。无需 secrets,fork 的 PR 也能运行。
- **`fetch-skills.yml`**(每日 02:00 UTC + 手动):全量抓取作为每日金丝雀 → 续抓校验(第二次运行重存数 ≤1%)→ `verify.mjs` → 强制推送每日提交到 [`dist` 分支](README.zh-CN.md#数据在哪里),历史只保留最近 5 个。工作流用长效 `VERCEL_TOKEN` 现场换取新鲜 OIDC token(所需 secrets:`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`——后两项在 `vercel link` 后从 `.vercel/project.json` 复制)。
