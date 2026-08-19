# 🎉 Telegram 抽奖机器人 v3.0 (Cloudflare Workers)

[![Deploy with GitHub Actions](https://github.com/your-repo/tg-lottery-bot-v3/actions/workflows/deploy.yml/badge.svg)](https://github.com/your-repo/tg-lottery-bot-v3/actions)

一个轻量级、无服务器的 Telegram 抽奖机器人，部署在 **Cloudflare Workers** 上，使用 **KV** 存储数据。

---

## ✨ v3.0 优化亮点

| # | 优化项 | 说明 |
|---|--------|------|
| 1 | **幂等处理** | 记录已处理的 `update_id`，防止 Telegram 重放消息 |
| 2 | **乐观锁防并发** | KV 写入带 `version` 字段，高并发参与时自动重试 |
| 3 | **加密安全随机** | 开奖使用 `crypto.getRandomValues` + Fisher-Yates |
| 4 | **KV 读写优化** | 参与者用 `Set`（O(1) 查询）；用户名缓存 |
| 5 | **Webhook 签名验证** | 支持 `X-Telegram-Bot-Api-Secret-Token` |
| 6 | **API 重试 + 限流** | 429 自动退避 + 网络错误指数退避 |
| 7 | **消息编辑** | 参与成功编辑原消息，减少刷屏 |
| 8 | **`/my` 补全** | 显示我参与/创建的抽奖 |
| 9 | **列表排序** | 进行中优先 + 时间倒序 |

---

## 🚀 一键部署（3 步）

KV 命名空间由 GitHub Actions **自动创建**，你不需要手动操作。

### Step 1 — 配置 GitHub Secrets

GitHub → 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加 **3 个**：

| Secret | 必填 | 在哪拿 |
|--------|------|--------|
| `CF_API_TOKEN` | ✅ | Cloudflare → Workers & Pages → API Tokens → 创建一个（权限：Workers Edit + KV Edit） |
| `CF_ACCOUNT_ID` | ✅ | Cloudflare Dashboard 顶部地址栏 |
| `BOT_TOKEN` | ✅ | Telegram [BotFather](https://t.me/BotFather) → `/newbot` |

> `WEBHOOK_SECRET` 可选，不填则跳过签名验证。

### Step 2 — 推代码

```bash
git push origin main
```

### Step 3 — 设置 Webhook

部署成功后，从 **Actions 日志** 或 Cloudflare Dashboard 获取 Worker URL，然后：

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
Telegram 用户消息
       ↓
Cloudflare Workers (Webhook)
  ├─ 签名验证 (HMAC-SHA256)
  ├─ 幂等去重 (update_id)
  └─ 路由分发
       ↓
Cloudflare KV（Actions 自动创建）
  ├─ lottery:{ID}      — 抽奖数据（含乐观锁 version）
  ├─ seen:{updateId}   — 幂等标记（30天过期）
  └─ chat:{chatId}:lotteries — 聊天室索引
       ↓
Telegram API（重试 + 限流退避）
```

---

## ⚙️ 完整 3 步速查

```
1️⃣ GitHub Secrets → 添加 CF_API_TOKEN / CF_ACCOUNT_ID / BOT_TOKEN
2️⃣ git push origin main  → Actions 自动创建 KV + 部署
3️⃣ curl 设置 Webhook → 完成
```

---

## 💰 成本

Cloudflare Workers 免费计划：**10万次请求/天 + 10万次 KV 读取/天 + 1000次 KV 写入/天**，个人使用完全免费。

---

## 📄 License

MIT License