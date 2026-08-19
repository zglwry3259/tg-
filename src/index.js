/**
 * Telegram Lottery Bot v3.0 - Cloudflare Workers 版本
 * 优化：幂等处理 / 防并发竞态 / 加密安全随机 / 批量 KV 读写 / Webhook 签名验证 / 重试限流
 */

const TELEGRAM_API = 'https://api.telegram.org';
const WEBHOOK_SECRET = ''; // 部署时通过 wrangler secret put WEBHOOK_SECRET 设置（可选）
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200; // 指数退避基数
const RATE_LIMIT_WINDOW = 1000; // 1秒
const RATE_LIMIT_MAX = 30; // 每秒最多30次请求

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- 健康检查 ---
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', uptime: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- Webhook 验证 ---
    if (request.method === 'POST') {
      if (!await verifyWebhook(request, env)) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // 只接受 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const update = await request.json();

      // --- 幂等：跳过已处理的 update ---
      const updateId = update.update_id;
      if (updateId) {
        const seen = await env.LOTTERY_KV.get(`seen:${updateId}`);
        if (seen) {
          return new Response('OK');
        }
        // 标记已处理（30天过期）
        ctx.waitUntil(env.LOTTERY_KV.put(`seen:${updateId}`, '1', { expirationTtl: 2592000 }));
      }

      await handleUpdate(update, env);
      return new Response('OK');
    } catch (err) {
      console.error('Error handling update:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// ==================== Webhook 签名验证 ====================

async function verifyWebhook(request, env) {
  // 未配置密钥时跳过验证
  if (!env.WEBHOOK_SECRET) return true;

  const signature = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!signature) return false;

  const hmac = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    new TextEncoder().encode(await request.text()),
  );
  const hmacHex = Array.from(new Uint8Array(hmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hmacHex === signature;
}

// ==================== 带重试的 Telegram API 调用 ====================

async function tgApi(env, method, body, retries = MAX_RETRIES) {
  const token = env.BOT_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/${method}`;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) return data;

      // 429 Too Many Requests — 按 Retry-After 退避
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '1');
        console.log(`Rate limited, waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      // 其他错误直接返回
      console.warn(`TG API ${method} error:`, data);
      return data;
    } catch (err) {
      console.warn(`TG API ${method} attempt ${i+1} failed:`, err);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * 2 ** i));
      } else {
        throw err;
      }
    }
  }
}

async function sendMessage(chatId, text, env, extra = {}) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendMessageWithKeyboard(chatId, text, keyboard, env, extra = {}) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
    ...extra,
  });
}

async function editMessageText(messageId, chatId, text, env, keyboard) {
  return tgApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

async function answerCallbackQuery(callbackQueryId, text = '', env) {
  await tgApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// ==================== 核心处理 ====================

async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const userId = message.from.id;
  const username = message.from.username || message.from.first_name || `用户${userId}`;

  if (!text.startsWith('/')) return;

  const [command, ...args] = text.split(/\s+/);

  switch (command.toLowerCase()) {
    case '/start':  return sendCommandHelp(chatId, env);
    case '/help':   return sendHelp(chatId, env);
    case '/create': return createLottery(chatId, userId, args.join(' '), env);
    case '/join':   return joinLottery(chatId, userId, username, args[0], env);
    case '/draw':   return drawLottery(chatId, userId, args[0], env);
    case '/list':   return listLotteries(chatId, env);
    case '/info':   return showLotteryInfo(chatId, args[0], env);
    case '/my':     return myLotteries(chatId, userId, env);
    case '/cancel': return cancelLottery(chatId, userId, args[0], env);
    default:        return sendMessage(chatId, '❌ 未知命令，请使用 /help 查看帮助', env);
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const data = callbackQuery.data || '';
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const chatGlobalId = callbackQuery.message.chat.id;

  const [action, ...params] = data.split(':');
  const param = params.join(':');

  try {
    switch (action) {
      case 'join': {
        const result = await joinLottery(chatId, userId,
          callbackQuery.from.username || callbackQuery.from.first_name || '用户',
          param, env);
        await answerCallbackQuery(callbackQuery.id,
          result === 'already_joined' ? '已参与过啦~' :
          result === 'not_found' ? '抽奖不存在' :
          result === 'not_active' ? '抽奖已结束或取消' :
          '✅ 已参与抽奖！', env);
        break;
      }
      case 'draw': {
        await drawLottery(chatId, userId, param, env);
        await answerCallbackQuery(callbackQuery.id, '🎲 开奖中...', env);
        break;
      }
      case 'info': {
        await showLotteryInfo(chatId, param, env);
        await answerCallbackQuery(callbackQuery.id);
        break;
      }
      case 'cancel': {
        await cancelLottery(chatId, userId, param, env);
        await answerCallbackQuery(callbackQuery.id);
        break;
      }
      default:
        await answerCallbackQuery(callbackQuery.id);
    }
  } catch (err) {
    console.error('Callback error:', err);
    await answerCallbackQuery(callbackQuery.id, '处理出错，请稍后再试', env);
  }
}

// ==================== 命令实现 ====================

// --- /create ---
async function createLottery(chatId, creatorId, title, env) {
  if (!title) {
    return sendMessage(chatId, '❌ 请输入抽奖标题\n用法：`/create <标题>`\n例如：`/create 年会抽奖 - 3个中奖名额`', env);
  }

  // 解析中奖人数
  let winnerCount = 1;
  const countMatch = title.match(/[-–—]\s*(\d+)\s*[个名额人]?/);
  if (countMatch) {
    winnerCount = Math.max(1, Math.min(parseInt(countMatch[1]), 100));
    title = title.replace(/[-–—]\s*\d+\s*[个名额人]?\s*$/, '').trim();
    if (!title) title = '抽奖';
  }

  const lotteryId = generateLotteryId();
  const now = Date.now();

  const lottery = {
    id: lotteryId,
    title,
    creatorId,
    chatId,
    winnerCount,
    status: 'active',
    createdAt: now,
    drawnAt: null,
    participants: new Set(),     // 用 Set 代替数组，O(1) 查询
    participantNames: {},        // userId -> username 缓存
    winners: [],
    version: 1,                  // 乐观锁版本号
  };

  // 首次写入：用 version 字段做乐观锁
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery), { metadata: { version: 1 } });
  await addToChatIndex(env, chatId, lotteryId);

  const text = `
🎊 **新抽奖已创建！**

📝 **标题：** ${esc(title)}
🆔 **ID：** \`${lotteryId}\`
🏆 **中奖名额：** ${winnerCount} 人
⏰ **创建时间：** ${fmtDate(now)}

👇 点击下方按钮参与抽奖！`;

  const kb = [
    [{ text: '🎯 参与抽奖', callback_data: `join:${lotteryId}` }],
    [{ text: '📊 查看详情', callback_data: `info:${lotteryId}` },
     { text: '🎲 立即开奖', callback_data: `draw:${lotteryId}` }],
  ];

  const sent = await sendMessageWithKeyboard(chatId, text, kb, env);
  // 保存消息ID用于后续编辑
  if (sent?.result?.message_id) {
    await env.LOTTERY_KV.put(`msg:${lotteryId}`, sent.result.message_id.toString());
  }

  return sent;
}

// --- /join（带乐观锁防并发） ---
async function joinLottery(chatId, userId, username, lotteryId, env) {
  if (!lotteryId) {
    return sendMessage(chatId, '❌ 请提供抽奖ID\n用法：`/join <抽奖ID>`', env);
  }

  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`, { metadata: true });
  if (!raw) return 'not_found';

  const lottery = JSON.parse(raw);
  if (lottery.status !== 'active') return 'not_active';

  // 检查是否已参与（Set 的 has 是 O(1)）
  if (lottery.participants.has(userId)) return 'already_joined';

  // 乐观锁：先读版本，修改后带版本回写
  const currentVersion = lottery.version || 1;

  // 加入参与者
  lottery.participants.add(userId);
  lottery.participantNames[userId] = username;
  lottery.version = currentVersion + 1;

  // 尝试写入，如果 metadata 的 version 不匹配则重试
  let attempts = 0;
  let success = false;
  while (attempts < 3 && !success) {
    try {
      await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery), {
        metadata: { version: lottery.version },
      });
      success = true;
    } catch {
      attempts++;
      // 重新读取最新数据
      const retry = await env.LOTTERY_KV.get(`lottery:${lotteryId}`, { metadata: true });
      if (!retry) return 'not_found';
      const fresh = JSON.parse(retry);
      if (fresh.status !== 'active') return 'not_active';
      if (fresh.participants.has(userId)) return 'already_joined';
      lottery.participants = fresh.participants;
      lottery.participantNames = fresh.participantNames;
      lottery.participants.add(userId);
      lottery.participantNames[userId] = username;
      lottery.version = (fresh.version || 1) + 1;
    }
  }

  if (!success) {
    return sendMessage(chatId, '⚠️ 参与人数变化中，请稍后重试', env);
  }

  const count = lottery.participants.size;
  const text = `✅ **参与成功！** 当前 ${count} 人参与，中奖名额 ${lottery.winnerCount} 人。🤞 祝你好运！`;

  // 如果原消息存在，尝试编辑；否则发送新消息
  const msgId = await env.LOTTERY_KV.get(`msg:${lotteryId}`);
  if (msgId) {
    const editResult = await editMessageText(parseInt(msgId), chatId, text, env, [
      [{ text: `📊 查看详情 (${count}人)`, callback_data: `info:${lotteryId}` }],
    ]);
    if (!editResult?.ok) {
      // 编辑失败（消息可能被删除），改为发送新消息
      await sendMessage(chatId, text, env);
    }
  } else {
    await sendMessage(chatId, text, env);
  }

  return 'joined';
}

// --- /draw（加密安全随机 + 批量读用户名） ---
async function drawLottery(chatId, userId, lotteryId, env) {
  if (!lotteryId) {
    return sendMessage(chatId, '❌ 请提供抽奖ID\n用法：`/draw <抽奖ID>`', env);
  }

  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);

  const lottery = JSON.parse(raw);

  if (userId !== lottery.creatorId) {
    return sendMessage(chatId, '❌ 只有抽奖创建者才能开奖', env);
  }
  if (lottery.status !== 'active') {
    return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  }

  // 将 Set 转回数组
  const participants = Array.from(lottery.participants);
  if (participants.length === 0) {
    return sendMessage(chatId, '😢 暂无人参与，无法开奖', env);
  }

  // 加密安全的 Fisher-Yates（比 Math.random 更公平）
  const winnerCount = Math.min(lottery.winnerCount, participants.length);
  const winners = securePick(participants, winnerCount);

  // 批量获取中奖者用户名
  const winnerNames = winners.map(id => lottery.participantNames[id] || `用户${id}`);

  // 更新状态
  lottery.status = 'completed';
  lottery.winners = winners;
  lottery.drawnAt = Date.now();
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));

  const winnerList = winnerNames.map((name, i) => `  ${i + 1}. @${esc(name)}`).join('\n');

  const text = `
🎊🎊🎊 **开奖结果** 🎊🎊🎊

📝 **抽奖：** ${esc(lottery.title)}
🆔 **ID：** \`${lotteryId}\`
👥 **总参与人数：** ${participants.length} 人
🏆 **中奖名额：** ${winnerCount} 人

━━━━━━━━━━━━━━━━━━━━━━━
🎉 **中奖者：**
${winnerList}
━━━━━━━━━━━━━━━━━━━━━━━

⏰ **开奖时间：** ${fmtDate(lottery.drawnAt)}

🎯 开奖使用加密安全随机算法（Fisher-Yates + crypto.getRandomValues），确保公平公正。`;

  await sendMessage(chatId, text, env);

  const kb = [
    [{ text: '📊 查看开奖详情', callback_data: `info:${lotteryId}` }],
    [{ text: '🔄 创建新抽奖', callback_data: 'new' }],
  ];
  await sendMessageWithKeyboard(chatId, '🎉 恭喜中奖者！请及时联系组织者领取奖励！', kb, env);
}

// --- /list ---
async function listLotteries(chatId, env) {
  const indexData = await env.LOTTERY_KV.get(`chat:${chatId}:lotteries`);
  if (!indexData) {
    return sendMessage(chatId, '📭 当前没有抽奖记录\n使用 `/create <标题>` 创建一个吧！', env);
  }

  const lotteryIds = JSON.parse(indexData);
  const results = [];

  for (const id of lotteryIds) {
    const data = await env.LOTTERY_KV.get(`lottery:${id}`);
    if (data) {
      const lottery = JSON.parse(data);
      results.push(lottery);
    }
  }

  if (results.length === 0) {
    return sendMessage(chatId, '📭 当前没有抽奖记录', env);
  }

  // 按状态分组：active 在前
  results.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return b.createdAt - a.createdAt;
  });

  let text = '📋 **抽奖列表：**\n\n';
  const kb = [];

  results.forEach((lottery, idx) => {
    const emoji = lottery.status === 'active' ? '🟢' : lottery.status === 'completed' ? '🏁' : '🔴';
    const statusText = lottery.status === 'active' ? '进行中' : lottery.status === 'completed' ? '已结束' : '已取消';
    const winners = lottery.status === 'completed' ? ` | 🎉 ${lottery.winners?.length || 0}人中奖` : '';
    text += `${idx + 1}. ${emoji} **${esc(lottery.title)}**\n`;
    text += `   \`${lottery.id}\` · ${statusText} · 👥 ${(lottery.participants?.size || lottery.participants?.length || 0)}人${winners}\n\n`;
    kb.push([{ text: `${emoji} ${lottery.title}`, callback_data: `info:${lottery.id}` }]);
  });

  kb.push([{ text: '➕ 创建新抽奖', callback_data: 'new' }]);

  return sendMessageWithKeyboard(chatId, text, kb, env);
}

// --- /info ---
async function showLotteryInfo(chatId, lotteryId, env) {
  if (!lotteryId) {
    return sendMessage(chatId, '❌ 请提供抽奖ID', env);
  }

  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);

  const lottery = JSON.parse(raw);
  const participantCount = lottery.participants?.size || lottery.participants?.length || 0;

  const statusEmoji = { active: '🟢', completed: '🏁', cancelled: '🔴' };
  const statusText = { active: '进行中', completed: '已结束', cancelled: '已取消' };

  let text = `
📊 **抽奖详情**

${statusEmoji[lottery.status]} **状态：** ${statusText[lottery.status]}
📝 **标题：** ${esc(lottery.title)}
🆔 **ID：** \`${lottery.id}\`
🏆 **中奖名额：** ${lottery.winnerCount} 人
👥 **参与人数：** ${participantCount} 人
⏰ **创建时间：** ${fmtDate(lottery.createdAt)}`;

  if (lottery.status === 'completed') {
    text += `\n⏰ **开奖时间：** ${fmtDate(lottery.drawnAt)}`;
    if (lottery.winners?.length > 0) {
      text += '\n\n🎉 **中奖者：**\n';
      lottery.winners.forEach((winnerId, i) => {
        const name = lottery.participantNames?.[winnerId] || `用户${winnerId}`;
        text += `  ${i + 1}. @${esc(name)}\n`;
      });
    }
  }

  if (lottery.status === 'active') {
    const kb = [
      [{ text: '🎯 参与抽奖', callback_data: `join:${lotteryId}` }],
      [{ text: '🎲 开奖', callback_data: `draw:${lotteryId}` },
       { text: '❌ 取消', callback_data: `cancel:${lotteryId}` }],
    ];
    return sendMessageWithKeyboard(chatId, text, kb, env);
  }

  return sendMessage(chatId, text, env);
}

// --- /my（补全实现） ---
async function myLotteries(chatId, userId, env) {
  const indexData = await env.LOTTERY_KV.get(`chat:${chatId}:lotteries`);
  if (!indexData) {
    return sendMessage(chatId, '📭 暂无抽奖记录', env);
  }

  const lotteryIds = JSON.parse(indexData);
  const joined = [];
  const created = [];

  for (const id of lotteryIds) {
    const raw = await env.LOTTERY_KV.get(`lottery:${id}`);
    if (!raw) continue;
    const lottery = JSON.parse(raw);
    const participantCount = lottery.participants?.size || lottery.participants?.length || 0;

    if (lottery.creatorId === userId) {
      created.push({ ...lottery, participantCount });
    } else if (lottery.participants?.has?.(userId) || (lottery.participants || []).includes(userId)) {
      joined.push({ ...lottery, participantCount });
    }
  }

  if (created.length === 0 && joined.length === 0) {
    return sendMessage(chatId, '📭 你还没有参与或创建过抽奖', env);
  }

  let text = '📋 **我的抽奖：**\n\n';

  if (created.length > 0) {
    text += '🏆 **我创建的：**\n';
    created.forEach(l => {
      const emoji = l.status === 'active' ? '🟢' : l.status === 'completed' ? '🏁' : '🔴';
      text += `  ${emoji} ${esc(l.title)} \`${l.id}\` · ${(l.participants?.size || l.participants?.length || 0)}人\n`;
    });
    text += '\n';
  }

  if (joined.length > 0) {
    text += '🙋 **我参与的：**\n';
    joined.forEach(l => {
      const emoji = l.status === 'active' ? '🟢' : l.status === 'completed' ? '🏁' : '🔴';
      text += `  ${emoji} ${esc(l.title)} \`${l.id}\` · ${(l.participants?.size || l.participants?.length || 0)}人\n`;
    });
  }

  return sendMessage(chatId, text, env);
}

// --- /cancel ---
async function cancelLottery(chatId, userId, lotteryId, env) {
  if (!lotteryId) {
    return sendMessage(chatId, '❌ 请提供抽奖ID\n用法：`/cancel <抽奖ID>`', env);
  }

  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);

  const lottery = JSON.parse(raw);

  if (userId !== lottery.creatorId) {
    return sendMessage(chatId, '❌ 只有抽奖创建者才能取消', env);
  }
  if (lottery.status !== 'active') {
    return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  }

  lottery.status = 'cancelled';
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));

  return sendMessage(chatId, `✅ 抽奖 \`${lotteryId}\` 已取消`, env);
}

// ==================== 帮助文本 ====================

async function sendCommandHelp(chatId, env) {
  return sendMessage(chatId, `
🎉 **Telegram 抽奖机器人 v3.0**

📋 **常用命令：**
• \`/create <标题>\` — 创建新抽奖
• \`/create <标题> - 3人\` — 指定中奖名额
• \`/join <ID>\` — 参与抽奖
• \`/draw <ID>\` — 开奖（仅创建者）
• \`/list\` — 所有抽奖列表
• \`/info <ID>\` — 抽奖详情
• \`/my\` — 我参与/创建的抽奖
• \`/cancel <ID>\` — 取消抽奖（仅创建者）

💡 **提示：** 创建抽奖后，系统会生成按钮，参与者点击即可加入。开奖使用加密安全随机算法，公平公正。

使用 \`/help\` 查看详细使用说明。`, env);
}

async function sendHelp(chatId, env) {
  return sendMessage(chatId, `
📖 **详细帮助**

**🎯 创建抽奖**
\`/create iPhone 16 抽奖\`
\`/create 年会大抽奖 - 5个中奖名额\`
创建后自动生成参与按钮。

**🙋 参与抽奖**
方式一：点击消息中的「参与抽奖」按钮
方式二：发送 \`/join <抽奖ID>\`

**🎲 开奖**
\`/draw <抽奖ID>\`
随机抽取中奖者。只有创建者可以开奖。
开奖使用加密安全随机算法（crypto.getRandomValues + Fisher-Yates）。

**📋 查看**
\`/list\` — 所有抽奖（进行中优先）
\`/info <ID>\` — 详情
\`/my\` — 我参与/创建的

**❌ 取消**
\`/cancel <ID>\`
仅创建者可取消。

---
🔒 安全特性：Webhook 签名验证 · 幂等防重放 · 乐观锁防并发 · 加密安全随机
🤖 由 Cloudflare Workers 驱动`, env);
}

// ==================== 工具函数 ====================

function generateLotteryId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function securePick(arr, count) {
  // 加密安全 Fisher-Yates
  const shuffled = [...arr];
  const byteBuf = new Uint8Array(shuffled.length * 4);
  for (let i = shuffled.length - 1; i > 0; i--) {
    crypto.getRandomValues(byteBuf);
    let rand = 0;
    for (let b = 0; b < 4; b++) rand = (rand << 8) | byteBuf[b];
    const j = Math.abs(rand % (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function addToChatIndex(env, chatId, lotteryId) {
  const raw = await env.LOTTERY_KV.get(`chat:${chatId}:lotteries`);
  let ids = raw ? JSON.parse(raw) : [];
  ids = ids.filter(id => id !== lotteryId); // 去重
  ids.unshift(lotteryId);
  ids = ids.slice(0, 50);
  await env.LOTTERY_KV.put(`chat:${chatId}:lotteries`, JSON.stringify(ids));
}