# Telegram 抽奖机器人 v4.1（Cloudflare Workers）

群组抽奖机器人：**私聊创建**，公告自动发布到你选择的**群聊**（和可选**频道**），
群内发口令参与，定时/人数自动开奖，开奖后私信通知中奖者、给创建者发中奖名单。

## 功能

- 📝 **私聊创建向导**（共 8 步）：活动名称 → 奖品 → 中奖名额 → 口令 → 开奖方式 → 开奖条件 → 选择发布群 → 频道(可选)
- 📢 **发布到群 + 频道**：创建完成后公告自动发到选定群；可另选频道同步发布（并可强制加频道）
- 🔑 **口令参与**：参与者在群内发送口令即参与
- ⏰ **定时开奖**（Cron 每分钟检查）/ 👥 **人数开奖**（满员自动开）
- 📣 **强制加频道**：可要求先加入指定频道才能参与
- 🥳 **开奖通知**：群内公告 + 私信中奖者 + 私信创建者中奖名单
- 📋 **管理**：`/list` 查看、`/draw <ID>` 手动开奖、`/cancel <ID>` 取消、`/groups` 查看 bot 已加入的群

## 部署

### 1. 准备工作

1. `@BotFather` 创建机器人，拿到 `BOT_TOKEN`
2. 把机器人加到你想要发布抽奖的群组，并设为**管理员**
3. 把机器人加为频道**管理员**（若要发布到频道/强制加频道）
4. Cloudflare 创建 KV Namespace，记录 Namespace ID

### 2. 配置 wrangler.toml

把 KV ID 填入：

```toml
[[kv_namespaces]]
binding = "LOTTERY_KV"
id = "你的KV_NAMESPACE_ID"
preview_id = "你的KV_NAMESPACE_ID"
```

Cron 触发器已声明（`crons = ["* * * * *"]`），部署时自动创建，用于定时开奖检查。

### 3. 设置 Cloudflare Worker Secrets

在 Cloudflare Dashboard → Worker → Settings → Variables：

| 变量 | 值 |
|------|-----|
| `BOT_TOKEN` | BotFather 给的 Token（**Secret**） |
| `WEBHOOK_SECRET` | 任意随机字符串（**Secret**，可选） |

### 4. GitHub Actions 一键部署

- GitHub Secrets 只填两个：`CF_API_TOKEN`（Workers Edit + KV Edit 权限）、`CF_ACCOUNT_ID`
- push 到 main 自动部署

### 5. 设置 Webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的worker域名>/webhook"
```

或使用 `scripts/setWebhook.mjs`。

## 使用

1. 私聊机器人发送 `/create`，按引导完成 8 步
2. 创建成功 → 公告自动发到选定的群（+频道）
3. 参与者在群里发口令参与
4. 到点/满员自动开奖；也可手动 `/draw <ID>`

## 权限说明

| 操作 | 需要 |
|------|------|
| bot 发公告到群 | bot 是群成员（建议管理员） |
| bot 发公告到频道 | bot 是频道管理员 |
| 强制加频道校验 | bot 是频道管理员 |
| 口令参与 | 群成员在群里发口令 |

## 目录

```
src/index.js          # 主逻辑
wrangler.toml         # Worker 配置（KV + Cron）
.github/workflows/deploy.yml  # GitHub Actions 自动部署
```