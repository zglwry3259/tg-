# 🎉 Telegram 抽奖机器人 v3.0 (Cloudflare Workers)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-repo/tg-lottery-bot-v3)
[![Deploy with GitHub Actions](https://github.com/actions/deploy-to-cloudflare/workflows/deploy.yml/badge.svg)](https://github.com/your-repo/tg-lottery-bot-v3/actions)

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

## 🚀 方式一：一键部署（推荐）

1. Fork 或 clone 本仓库到 GitHub
2. 在 Cloudflare Dashboard → Workers & Pages → **Create Application**
3. 选择 **Connect to Git** → 关联你的 GitHub 仓库
4. 配置变量（见下方 Secrets 列表）
5. 点 **Deploy**，Cloudflare 自动构建部署

---

## 🚀 方式二：GitHub Actions 自动部署

### 步骤

#### 1️⃣ 准备 Cloudflare API Token

Cloudflare Dashboard → **Workers & Pages** → **API Tokens** → Create Token

权限需要：
- Workers: **Edit**
- KV: **Edit**

复制 Token 备用。

#### 2️⃣ 准备 Bot Token

[BotFather](https://t.me/BotFather) → `/newbot` → 获取 Token

#### 3️⃣ 准备 KV 命名空间

```bash
npx wrangler login
npx wrangler kv namespace create "LOTTERY_KV"
# 复制返回的 id
```

打开 `wrangler.toml`，替换：
```toml
[[kv_namespaces]]
binding = "LOTTERY_KV"
id = "你的KV_NAMESPACE_ID"       # ← 替换
preview_id = "你的PREVIEW_KV_ID"  # ← 替换
```

#### 4️⃣ 配置 GitHub Secrets

GitHub → 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret 名称 | 值 | 来源 |
|------------|-----|------|
| `CF_API_TOKEN` | 上面步骤1生成的 Cloudflare Token | Cloudflare Dashboard |
| `CF_ACCOUNT_ID` | 你的 Cloudflare Account ID | Cloudflare Dashboard → Workers & Pages → 顶部 |
| `BOT_TOKEN` | Telegram Bot Token | BotFather |
| `WEBHOOK_SECRET` | 随机字符串（可选） | `openssl rand -hex 32` |

#### 5️⃣ 推送代码触发部署

```bash
git push origin main
```

GitHub Actions 会自动执行部署。查看 **Actions** tab 确认状态。

#### 6️⃣ 设置 Webhook

部署成功后，从 Actions 日志或 Cloudflare Dashboard 获取 Worker URL，设置 Webhook：

```bash
# 无签名密钥
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://tg-lottery-bot.<your-subdomain>.workers.dev"

# 有签名密钥（推荐）
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://tg-lottery-bot.<your-subdomain>.workers.dev&secret_token=你的WEBHOOK_SECRET"
```

---

## 🚀 方式三：本地 Wrangler 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create "LOTTERY_KV"
# 将 id 填入 wrangler.toml
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET   # 可选
npx wrangler deploy
```

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
Cloudflare KV
  ├─ lottery:{ID}      — 抽奖数据（含乐观锁 version）
  ├─ seen:{updateId}   — 幂等标记（30天过期）
  └─ chat:{chatId}:lotteries — 聊天室索引
       ↓
Telegram API（重试 + 限流退避）
```

---

## ⚙️ GitHub Secrets 速查

| Secret | 必填 | 说明 |
|--------|------|------|
| `CF_API_TOKEN` | ✅ | Cloudflare Workers API Token（权限：Workers Edit + KV Edit） |
| `CF_ACCOUNT_ID` | ✅ | Cloudflare Account ID |
| `BOT_TOKEN` | ✅ | Telegram Bot Token |
| `WEBHOOK_SECRET` | ❌ | 签名密钥，可选 |

---

## 💰 成本

Cloudflare Workers 免费计划：**10万次请求/天 + 10万次 KV 读取/天 + 1000次 KV 写入/天**，个人使用完全免费。

---

## 📄 License

MIT License