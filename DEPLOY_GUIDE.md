# 🚀 群组管家 v6.5 详细部署教程（小白版）

> 目标：把「抽奖（多奖品 + 兑奖）+ 入群验证 + 管理员公告 + 投票 + 群管工具」的 Telegram 群组管家部署到 Cloudflare Workers，
> 并接上 GitHub Actions 实现「推代码自动部署」。

**v6.5 新增功能（相比 v6.4）：**
- 🎁 **多奖品抽奖**：创建奖品时可回复多个奖品名（继续添加/结束添加按钮），开奖按中奖顺序一一对应
- 🎟️ **中奖兑奖**：参与成功/中奖通知里都有「兑奖」入口，中奖者可一键领取兑奖码；`/start redeem` 查看全部中奖记录
- 🖱️ **内联键盘化**：`/list` 抽奖记录改为按钮展示，可直达「立即开奖 / 结束本次抽奖」（二次确认）
- 🎟️ **中奖兑换码**：创建抽奖时可开启兑换码，开奖时 bot 自动私信发放
- 🛡️ **入群验证**：新人入群自动禁言 + 发验证按钮，点击后解禁；10分钟未验证自动移出（`/verify on|off` 按群开关）
- 📢 **管理员公告**：群管理员 `/announce 内容` 发公告并**自动置顶**
- 📌 **抽奖公告自动置顶**：创建抽奖后公告自动 pin，开奖/取消时自动取消置顶
- 📊 **投票**：`/poll 问题|选项1|选项2` 发起匿名群投票（`--multi` 多选）

---

## 一、准备工作（需要 3 个账号）

| 需要 | 用途 |
|------|------|
| Telegram 账号 | 创建机器人、拿 BOT_TOKEN |
| Cloudflare 账号 | 部署 Worker、存储 KV |
| GitHub 账号 | 托管代码、自动部署 |

---

## 二、第一步：创建 Telegram 机器人

1. 在 Telegram 里搜索 **@BotFather**（官方机器人），点进去
2. 发送 `/newbot`
3. 按提示输入机器人名字（如 `LotteryBot`）
4. 再输入机器人用户名（必须以 `bot` 结尾，如 `mylottery_bot`）
5. 成功后 BotFather 会返回：

```
Use this token to access the HTTP API:
123456789:AAFxxxxxxx-xxxxx
```

> ⚠️ **BOT_TOKEN** 就是上面这串 `数字:字母`，先复制保存好，后面要用两次。

6. 可选：给机器人设置头像、描述等
7. **把机器人拉进你的群**：
   - 打开你的群 → 成员 → 添加成员 → 搜索机器人用户名 → 添加
   - **必须设为管理员**：群设置 → 管理员 → 添加管理员 → 选机器人 → 勾选最少权限（或直接给全部）
8. **若有频道**（可选，发公告到频道/强制加频道用）：
   - 把机器人也加为频道的**管理员**

---

## 三、第二步：Cloudflare 创建 KV Namespace

KV 用来存抽奖数据（活动、参与者等）。

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages**
3. 点击右侧 **KV**
4. 点击 **Create a namespace**
   - Name 填：`LOTTERY_KV`（或任意名字）
5. 创建后，会显示：

```
KV namespace ID:
a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

> ⚠️ 复制这个 **Namespace ID**，之后要填进 `wrangler.toml`。

---

## 四、第三步：GitHub 建仓库、推代码

### 1. 创建 GitHub 仓库

1. 登录 [github.com](https://github.com)
2. 右上角 **+** → **New repository**
3. Repository name 填：`tg-lottery-bot`
4. 选择 **Private**（私有仓库，保护你的代码）
5. 点 Create repository

### 2. 在项目根目录初始化 git 并推送

在装有本项目的电脑终端里执行：

```bash
cd tg-lottery-bot-v3          # 进入项目目录
git init
git add .
git commit -m "v4.1 抽奖机器人"
git branch -M main
git remote add origin https://github.com/你的用户名/tg-lottery-bot.git
git push -u origin main
```

> 如果不想用命令行，也可以直接在 GitHub 网页上传文件：
> 仓库页面 → **Add file → Upload files** → 把 `src`、`wrangler.toml`、`package.json`、`.github` 全部拖进去 → Commit changes。

---

## 五、第四步：配置 wrangler.toml（填 KV ID）

用编辑器打开项目里的 `wrangler.toml`，把 KV ID 填进去：

```toml
[[kv_namespaces]]
binding = "LOTTERY_KV"
id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"        # ← 填你的 KV Namespace ID
preview_id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"  # ← 同 ID 即可
```

> ⚠️ 这里的 `crons = ["* * * * *"]` 不用动，是定时开奖用的 Cron 触发器。

改完记得重新 commit 并 push：

```bash
git add wrangler.toml
git commit -m "填 KV ID"
git push
```

---

## 六、第五步：GitHub Secrets（自动部署钥匙）

GitHub Actions 需要你的 Cloudflare 凭证才能自动部署。

### 1. Cloudflare 生成 API Token

1. [dash.cloudflare.com](https://dash.cloudflare.com) → 右下角头像 → **My Profile**
2. 左侧 **API Tokens** → **Create Token**
3. 点 **Get started**（自定义模板）：
   - Token name：`workers-deploy`
   - Permissions：
     - 第一条：`Account - Workers Scripts - Edit`
     - 第二条（点 Add more）：`Account - Workers KV Storage - Edit`
   - Account Resources：Include → 你的账号
4. 点 **Continue → Create Token**
5. 会显示一串 `xxxxxxxxxxxxxxxxxxxxxxxx`，**只显示一次**，复制保存！

### 2. Cloudflare 查找 Account ID

1. [dash.cloudflare.com](https://dash.cloudflare.com) 首页右侧栏能看到 **Account ID**
2. 或者：左侧 Workers & Pages → 右上角有 Account ID

### 3. GitHub 添加 Secrets

1. GitHub 仓库页面 → **Settings** → 左侧 **Secrets and variables → Actions**
2. 点 **New repository secret**，添加两个：

| Secret 名字 | 填什么 |
|-------------|--------|
| `CF_API_TOKEN` | 刚才创建的 Cloudflare API Token |
| `CF_ACCOUNT_ID` | 你的 Cloudflare Account ID |

> ⚠️ 注意：Secret 名首尾不要有空格，值必须准确。

---

## 七、第六步：设置 Bot 令牌和 Webhook 密钥（Worker Secrets）

BOT_TOKEN 不能放 GitHub，直接放 Cloudflare Worker 的变量里，更安全。

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
2. 等自动部署跑完后（或手动部署），列表里会出现 `tg-lottery-bot`（Worker 名）
3. 点进 Worker → **Settings → Variables**
4. 在 **Secrets** 区域点 **Add**：
   - 名字：`BOT_TOKEN`
   - 值：`123456789:AAFxxxxxxx-xxxxx`（你 BotFather 的 Token）
   - 类型：**Secret**（勾上 Encrypt 可选）
5. 添加第二个 Secret：
   - 名字：`WEBHOOK_SECRET`
   - 值：随便一串随机字符（如 `my-secret-2026`）
6. 点 **Save**，然后到 **Deployments** 点 **Deploy** 让改动生效

---

## 八、第七步：部署 Worker（两种方式任选）

### 方式 A：GitHub Actions 自动部署（推荐）

1. 确保代码已 push 到 GitHub 的 `main` 分支
2. 仓库页面 → **Actions** → 应该能看到 workflow 在跑（`Deploy to Cloudflare Workers`）
3. 等绿色 ✅ 出现 = 部署成功

以后每次 `git push` 都会自动重新部署。

### 方式 B：本地命令行部署

有 Node.js 的环境下：

```bash
cd tg-lottery-bot-v3
npm install
npx wrangler login          # 浏览器授权 Cloudflare
npx wrangler deploy
```

---

## 九、第八步：设置 Webhook（让 Telegram 把消息推给 Worker）

### 方式 1：用脚本（推荐）

项目里已带脚本：

```bash
node scripts/setWebhook.mjs <BOT_TOKEN> https://tg-lottery-bot.<你的子域>.workers.dev/webhook <WEBHOOK_SECRET>
```

例：

```bash
node scripts/setWebhook.mjs 123456789:AAFxxxx https://tg-lottery-bot.example.workers.dev/webhook my-secret-2026
```

> Worker 域名显示在：Cloudflare → Workers & Pages → 你的 Worker → 右上角 `workers.dev` 域名

### 方式 2：直接用 curl

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://tg-lottery-bot.<你的子域>.workers.dev/webhook","secret_token":"my-secret-2026","allowed_updates":["message","callback_query","my_chat_member","chat_member"]}'
```

### 验证

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

返回里看到：

```json
{
  "ok": true,
  "result": {
    "url": "https://tg-lottery-bot.example.workers.dev/webhook",
    "pending_update_count": 0
  }
}
```

`pending_update_count: 0` 即为成功。

---

## 十、第九步：确认 Cron 触发器已生效

1. Cloudflare → Workers & Pages → 你的 Worker
2. 切到 **Triggers** 标签
3. 在 **Cron Triggers** 区域能看到 `* * * * *`
4. 如果没有，点 **Add Cron Trigger**，选 Every minute（每分钟）→ Save

> 这是「定时开奖」的命脉！漏了它，到点后群里没人说话就不会自动开奖。

---

## 十一、第十步：功能自测清单

按顺序测，结果都符合才说明部署成功：

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 私聊机器人 `/start` | 返回欢迎语 |
| 2 | 私聊 `/groups` | 能看到你之前拉机进群的那个群（若没有，先去群里 @机器人，回私聊再 /groups） |
| 3 | 私聊 `/create` | 进入 10 步向导 |
| 4 | 填名称→奖品→名额→口令→开奖方式→条件 | 每步都有确认 |
| 5 | 选择发布群 | 按钮里出现你的群 |
| 6 | 频道留空点跳过 | 群内收到「抽奖开始啦！」公告 |
| 7 | 群里发口令 | 提示参与成功、人数 +1 |
| 8 | `/draw <ID>` 或等到期/满员 | 群内开奖公告 + 中奖者收到私信 |
| 9 | 创建者私聊 `/list` | 能看到自己的抽奖 |

---

## 十二、常见问题排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 群里没收到公告 | bot 不在群里 / 不是管理员 | 把 bot 拉进群并设为管理员，重启创建 |
| 公告发到频道失败 | bot 不是频道管理员 | 把 bot 加成频道管理员 |
| 参与提示「请先加入频道」 | 未加频道 / bot 无法校验 | 让用户先关注频道，确保 bot 是频道管理员 |
| 定时开奖不触发 | Cron 未配置 | 看第十步，手动加每分钟 Cron |
| setWebhook 返回 404 | Worker 域名不对 | 用 Workers & Pages 里的正确 workers.dev 域名 |
| 部署报 KV 错误 | KV ID 没填对 | 检查 wrangler.toml 两处 ID |
| Actions 红叉 | Secrets 没配好 | 检查 CF_API_TOKEN / CF_ACCOUNT_ID 是否正确添加 |

---

## 十三、常用命令速查

| 命令 | 作用 |
|------|------|
| `/create` | 私聊创建抽奖（10 步向导） |
| `/list` | 查看抽奖（私聊看自己的 / 群里看本群的） |
| `/draw <ID>` | 手动开奖 |
| `/cancel <ID>` | 取消抽奖 |
| `/groups` | 看 bot 加入的群 |

---

> 📌 本教程针对 v4.1。代码更新后推送 GitHub 即自动重新部署，Webhook 无需重复设置。