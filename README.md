# 🎉 Telegram 抽奖机器人 v3.0 (Cloudflare Workers)

一个轻量级、无服务器的 Telegram 抽奖机器人，部署在 **Cloudflare Workers** 上，使用 **KV** 存储数据。

---

## ✨ v3.0 优化亮点

| # | 优化项 | 说明 |
|---|--------|------|
| 1 | **幂等处理** | 记录 `update_id`，防止 Telegram 重放 |
| 2 | **乐观锁防并发** | KV 写入带 `version`，高并发参与自动重试 |
| 3 | **加密安全随机** | `crypto.getRandomValues` + Fisher-Yates |
| 4 | **KV 读写优化** | `Set` O(1) 查询；用户名缓存 |
| 5 | **Webhook 签名验证** | HMAC-SHA256 |
| 6 | **API 重试 + 限流** | 429 退避 + 网络错误指数退避 |
| 7 | **消息编辑** | 参与成功编辑原消息，减少刷屏 |
| 8 | **`/my` 补全** | 我参与/创建的抽奖 |
| 9 | **列表排序** | 进行中优先 + 时间倒序 |

---

## 🚀 一键部署（3 步）

KV 命名空间由 GitHub Actions **自动创建**。

### Step 1 — 配置 3 个 GitHub Secrets

GitHub → 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | 必填 | 在哪拿 |
|--------|------|--------|
| `CF_API_TOKEN` | ✅ | Cloudflare → Workers & Pages → API Tokens → **Create Token**（权限：Workers **Edit** + KV **Edit**） |
| `CF_ACCOUNT_ID` | ✅ | Cloudflare Dashboard 顶部地址栏 |
| `BOT_TOKEN` | ✅ | Telegram [BotFather](https://t.me/BotFather) → `/newbot` |

> ⚠️ 确认 Cloudflare Token 同时拥有 **Workers Edit** 和 **KV Edit** 权限，否则 KV 创建会失败。

### Step 2 — 推代码触发部署

```bash
git push origin main
```

GitHub Actions 将自动：
1. 创建 `LOTTERY_KV` 命名空间
2. 将 KV ID 写入 `wrangler.toml`
3. 部署到 Cloudflare Workers

查看 **Actions** → 部署日志确认成功。

### Step 3 — 设置 Webhook

从 Actions 日志或 Cloudflare Dashboard 获取 Worker URL，然后：

```bash
curl "https://api.telegram.org/bot你的TOKEN/setWebhook?url=https://tg-lottery-bot.YOURNAME.workers.dev"
```

在 Telegram 发 `/start` 验证 ✅

---

## 📖 命令一览

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎界面 |
| `/help` | 详细帮助 |
| `/create <标题>` | 创建抽奖 |
| `/create <标题> - N人` | 指定中奖名额 |
| `/join <ID>` | 参与抽奖 |
| `/draw <ID>` | 开奖（仅创建者） |
| `/list` | 所有抽奖列表 |
| `/info <ID>` | 抽奖详情 |
| `/my` | 我参与/创建的抽奖 |
| `/cancel <ID>` | 取消抽奖（仅创建者） |

---

## 🏗️ 架构

```
Telegram → Workers(Webhook) → KV(自动创建) → Telegram API
```

---

## 💰 成本

Cloudflare Workers 免费：**10万次请求/天 + 10万次 KV 读取/天 + 1000次 KV 写入/天**。

---

## 📄 License

MIT