# 群组管家 v5.0（原 抽奖机器人 v4.1，Cloudflare Workers）

群组管家 Bot：**私聊创建抽奖**，公告自动发布到**群聊**（并**自动置顶**）和可选**频道**；
群内口令参与、定时/人数开奖、私信中奖通知；同时内置**入群验证**、**管理员公告**、**群投票**模块。

## 功能

### 🎁 抽奖模块
- 📝 **私聊创建向导**（共 8 步）：活动名称 → 奖品 → 中奖名额 → 口令 → 开奖方式 → 开奖条件 → 选择发布群 → 频道(可选)
- 📢 **发布到群 + 频道，自动置顶**：创建完成后公告自动发到选定群并 **pin 置顶**；开奖/取消时自动取消置顶
- 🔑 **口令参与**：参与者在群内发送口令即参与
- ⏰ **定时开奖**（Cron 每分钟检查）/ 👥 **人数开奖**（满员自动开）
- 📣 **强制加频道**：可要求先加入指定频道才能参与
- 🥳 **开奖通知**：群内公告 + 私信中奖者 + 私信创建者中奖名单

### 🛡️ 入群验证模块
- 新成员加入时自动**禁言**并发送验证按钮，点击后解除禁言并欢迎入群
- 10 分钟未验证自动**移出群聊**（bot 需为群管理员）
- 按群开关：管理员发送 `/verify on|off` 控制

### 📢 管理员公告模块
- 群管理员发送 `/announce 内容`，发布公告并**自动置顶**
- 非管理员使用会被拒绝

### 📊 投票模块
- `/poll 问题|选项1|选项2|...` 发起群投票（Telegram 原生匿名投票，最多10选项）
- 支持多选：`/poll --multi 问题|选项1|选项2`

### 📋 其他
- `/list` 查看抽奖、`/draw <ID>` 手动开奖、`/cancel <ID>` 取消、`/groups` 查看 bot 已加入的群

## 部署

### 1. 准备工作

1. `@BotFather` 创建机器人，拿到 `BOT_TOKEN`
2. 把机器人加到你想要发布抽奖的群组，并设为**管理员**（入群验证/置顶/踢人都需要）
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

Cron 触发器已声明（`crons = ["* * * * *"]`），部署时自动创建，用于定时开奖 + 入群验证超时检查。

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

或使用 `scripts/setWebhook.mjs`（已包含 `chat_member` 更新，入群验证必需）。

> ⚠️ 升级自 v4.1 时：部署后请重新设置一次 Webhook（或运行 `setWebhook.mjs`），
> 以便 allowed_updates 加入 `chat_member`；命令菜单会由 Cron 自动刷新一次（v5 标记）。

## 使用