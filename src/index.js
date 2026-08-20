/**
 * Telegram Lottery Bot v4.1 - Cloudflare Workers
 * 私聊创建 + 发布到群聊/频道 + 口令参与 + 强制加频道 + 创建向导 + 私信中奖通知
 */

const TELEGRAM_API = 'https://api.telegram.org';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', uptime: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
      const update = await request.json();
      const updateId = update.update_id;
      if (updateId) {
        const seen = await env.LOTTERY_KV.get(`seen:${updateId}`);
        if (seen) return new Response('OK');
        ctx.waitUntil(env.LOTTERY_KV.put(`seen:${updateId}`, '1', { expirationTtl: 86400 }));
      }
      await handleUpdate(update, env);
      return new Response('OK');
    } catch (err) {
      console.error('Error:', err);
      return new Response('OK');
    }
  },

  // 每分钟触发：定时开奖检查
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkScheduledDraws(env));
  },
};

// ==================== 定时开奖（Cron） ====================

async function checkScheduledDraws(env) {
  try {
    const raw = await env.LOTTERY_KV.get('scheduled_draws');
    if (!raw) return;
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids) || ids.length === 0) return;

    const now = Date.now();
    const remaining = [];
    for (const id of ids) {
      const kraw = await env.LOTTERY_KV.get(`lottery:${id}`);
      if (!kraw) continue;
      const lottery = JSON.parse(kraw);
      if (lottery.status !== 'active') continue; // 已完成/取消，从列表剔除
      if (now < lottery.triggerValue) {
        remaining.push(id);
        continue;
      }
      // 到点了
      if (lottery.participants.length === 0) {
        lottery.status = 'cancelled';
        await env.LOTTERY_KV.put(`lottery:${id}`, JSON.stringify(lottery));
        await sendMessage(lottery.groupId, `⏰ 开奖时间已到，但「${esc(lottery.name)}」无人参与，已自动取消`, env);
      } else {
        await executeDraw(id, lottery, env, lottery.groupName);
      }
      // 已处理，不加回 remaining
    }
    await env.LOTTERY_KV.put('scheduled_draws', JSON.stringify(remaining));
  } catch (err) {
    console.error('Scheduled draw error:', err);
  }
}

async function addToScheduled(env, lotteryId) {
  const raw = await env.LOTTERY_KV.get('scheduled_draws');
  let ids = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(ids)) ids = [];
  if (!ids.includes(lotteryId)) ids.push(lotteryId);
  await env.LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids));
}

async function removeFromScheduled(env, lotteryId) {
  const raw = await env.LOTTERY_KV.get('scheduled_draws');
  if (!raw) return;
  let ids = JSON.parse(raw);
  if (!Array.isArray(ids)) return;
  ids = ids.filter(id => id !== lotteryId);
  await env.LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids));
}

// ==================== 路由 ====================

async function handleUpdate(update, env) {
  if (update.message) await handleMessage(update.message, env);
  else if (update.callback_query) await handleCallbackQuery(update.callback_query, env);
  else if (update.my_chat_member) await handleMyChatMember(update.my_chat_member, env);
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || `用户${userId}`;
  const text = (msg.text || '').trim();
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || '';

  // ---- 命令 ----
  if (text.startsWith('/')) {
    const [cmd, ...args] = text.split(/\s+/);
    const cmdLower = cmd.toLowerCase();
    if (cmdLower === '/start') {
      return sendMessage(chatId, '🎉 **抽奖机器人 v4.1**\n\n私聊中发送 /create 即可创建抽奖，创建后公告会发布到你选择的群聊（和频道）！', env);
    }
    if (cmdLower === '/create') {
      return startWizard(chatId, userId, username, chatTitle, env);
    }
    if (cmdLower === '/draw') {
      return drawLottery(chatId, userId, args[0], env, chatTitle);
    }
    if (cmdLower === '/cancel') {
      return cancelLotteryCmd(chatId, userId, args[0], env, chatTitle);
    }
    if (cmdLower === '/list') {
      return listLotteries(chatId, env, chatTitle, userId);
    }
    if (cmdLower === '/groups') {
      return refreshGroupsCmd(chatId, userId, env);
    }
    return;
  }

  // ---- 私聊：向导步骤 ----
  if (chatType === 'private') {
    return handleWizardStep(chatId, userId, text, env);
  }

  // ---- 群聊：检查口令 ----
  if (chatType === 'group' || chatType === 'supergroup') {
    return checkKeyword(chatId, userId, username, text, chatTitle, env);
  }
}

// ==================== Bot 入群记录（发布目标群列表） ====================

async function handleMyChatMember(mcm, env) {
  const chat = mcm.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  const newStatus = mcm.new_chat_member?.status || '';

  const key = 'bot_groups';
  const raw = await env.LOTTERY_KV.get(key);
  let groups = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(groups)) groups = [];

  const idx = groups.findIndex(g => g.id === chat.id);
  if (newStatus === 'left' || newStatus === 'kicked') {
    if (idx >= 0) groups.splice(idx, 1);
  } else if (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'restricted') {
    const g = { id: chat.id, title: chat.title || `群${chat.id}` };
    if (idx >= 0) groups[idx] = g;
    else groups.push(g);
  }
  await env.LOTTERY_KV.put(key, JSON.stringify(groups));
}

async function getBotGroups(env) {
  const raw = await env.LOTTERY_KV.get('bot_groups');
  if (!raw) return [];
  const groups = JSON.parse(raw);
  return Array.isArray(groups) ? groups : [];
}
// ==================== 创建向导（私聊） ====================

async function startWizard(chatId, userId, username, chatTitle, env) {
  // 仅允许私聊创建；群聊中提示去私聊
  if (chatId < 0) {
    return sendMessage(chatId, 'ℹ️ @抽奖机器人：创建抽奖请在私聊中发送 /create。', env);
  }

  const wizard = {
    userId,
    step: 1,
    data: { name: '', prize: '', winnerCount: 1, keyword: '', triggerType: '', triggerValue: null, channel: '', groupId: null, groupName: '' },
  };
  await env.LOTTERY_KV.put(`wizard:${userId}`, JSON.stringify(wizard), { expirationTtl: 3600 });

  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];
  return sendMsgKb(chatId, `🎯 **抽奖创建向导**（第1步/共8步）\n\n📝 请输入**抽奖活动名称**：`, kb, env);
}

async function handleWizardStep(chatId, userId, text, env) {
  const wizardKey = `wizard:${userId}`;
  const raw = await env.LOTTERY_KV.get(wizardKey);
  if (!raw) return;

  const wizard = JSON.parse(raw);
  if (wizard.step < 1 || wizard.step > 8) return;

  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];

  switch (wizard.step) {
    case 1: // 活动名称
      wizard.data.name = text;
      wizard.step = 2;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 活动名称：**${esc(text)}**\n\n🎁 第2步：请输入**奖品名称**：`, kb, env);

    case 2: // 奖品
      wizard.data.prize = text;
      wizard.step = 3;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 奖品：**${esc(text)}**\n\n🏆 第3步：请输入**中奖名额数量**（默认1人）：`, kb, env);

    case 3: // 中奖名额
      let wc = parseInt(text);
      if (isNaN(wc) || wc < 1 || wc > 100) {
        return sendMsgKb(chatId, '❌ 请输入1~100之间的数字', kb, env);
      }
      wizard.data.winnerCount = wc;
      wizard.step = 4;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 中奖名额：**${wc} 人**\n\n🔑 第4步：请输入**参与口令**\n参与者在群内发送此口令即可参与：`, kb, env);

    case 4: // 口令
      if (!text.trim()) {
        return sendMsgKb(chatId, '❌ 口令不能为空', kb, env);
      }
      wizard.data.keyword = text.trim();
      wizard.step = 5;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const triggerKb = [
        [{ text: '⏰ 定时开奖', callback_data: 'trigger_type:time' },
         { text: '👥 人数开奖', callback_data: 'trigger_type:count' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      return sendMsgKb(chatId, `✅ 口令：\`${esc(wizard.data.keyword)}\`\n\n⏰ 第5步：请选择**开奖方式**：`, triggerKb, env);

    case 6: // 开奖条件值
      if (wizard.data.triggerType === 'time') {
        const timeMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (!timeMatch) {
          return sendMsgKb(chatId, '❌ 时间格式错误，请使用格式：`2024-12-25 20:00`', kb, env);
        }
        const [, y, m, d, h, min] = timeMatch;
        const targetTime = new Date(+y, +m - 1, +d, +h, +min, 0);
        if (targetTime <= Date.now()) {
          return sendMsgKb(chatId, '❌ 开奖时间必须在当前时间之后', kb, env);
        }
        wizard.data.triggerValue = targetTime.getTime();
      } else {
        const count = parseInt(text);
        if (isNaN(count) || count < 2 || count > 1000) {
          return sendMsgKb(chatId, '❌ 请输入2~1000之间的数字', kb, env);
        }
        wizard.data.triggerValue = count;
      }

      wizard.step = 7;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      // 列出 bot 已加入的群供选择，或手动输入群 ID/链接
      const groups = await getBotGroups(env);
      if (groups.length === 0) {
        return sendMsgKb(chatId, `⚠️ **还未找到可发布群**\n\n请先把机器人**加入目标群组**（并设为管理员），然后发送 \`/groups\` 刷新，或直接输入群 ID（如 \`-1001234567890\`）。`, kb, env);
      }
      const groupKb = [];
      for (const g of groups.slice(0, 12)) {
        groupKb.push([{ text: `📢 ${esc(g.title || g.id)}`, callback_data: `select_group:${g.id}` }]);
      }
      groupKb.push([{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]);
      return sendMsgKb(chatId, `✅ ${
        wizard.data.triggerType === 'time' ? '开奖时间' : '人数上限'
      }：\`${text}\`\n\n📢 第7步：请选择**公告发布群**（公告发到该群，参与也在此群）：`, groupKb, env);

    case 7: // 选择发布群（也可手动输入群ID/链接）
      const rawGroup = text.trim();
      let groupId = null;
      let groupName = '';

      if (/^-?\d+$/.test(rawGroup)) {
        groupId = parseInt(rawGroup);
      } else {
        // 尝试 t.me/ 链接或 @username → 需要 bot 已在群内，用 getChat 解析
        const m = rawGroup.match(/t\.me\/([A-Za-z0-9_]+)/) || rawGroup.match(/^@?([A-Za-z0-9_]{3,})$/);
        if (m) {
          try {
            const res = await tgApi(env, 'getChat', { chat_id: `@${m[1]}` });
            if (res.ok) {
              groupId = res.result.id;
              groupName = res.result.title || m[1];
            }
          } catch {}
        }
        if (!groupId) {
          return sendMsgKb(chatId, '❌ 无法解析该群，请直接输入群 ID（如 `-1001234567890`），或在第7步按钮中选择。', kb, env);
        }
      }

      if (!groupId) {
        return sendMsgKb(chatId, '❌ 请输入有效的群 ID，或从按钮中选择。', kb, env);
      }

      // 校验 bot 是否在该群（可选，放宽：允许任意 ID）
      wizard.data.groupId = groupId;
      wizard.data.groupName = groupName;
      wizard.step = 8;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const channelKb = [
        [{ text: '⏭️ 跳过（不发布到频道）', callback_data: 'skip_channel' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      return sendMsgKb(chatId, `✅ 发布群：\`${groupId}\`${groupName ? `（${esc(groupName)}）` : ''}\n\n📢 第8步（可选）：请输入**频道**链接或用户名\n例如：\`@mychannel\`\n公告会同时发布到该频道（并可设为强制加频道）\n（点击跳过则只发布到群）`, channelKb, env);

    case 8: // 频道（可选）
      let channelInput = text.trim();
      if (!channelInput) {
        return sendMsgKb(chatId, '❌ 频道不能为空，或点「跳过」不发布到频道', kb, env);
      }
      channelInput = channelInput.replace(/^https?:\/\/t\.me\//i, '');
      if (channelInput && !channelInput.startsWith('@')) channelInput = '@' + channelInput;
      wizard.data.channel = channelInput;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      await finishWizard(chatId, null, userId, wizard, env);
      return;

    default:
      return;
  }
}
// ==================== 回调处理 ====================

async function handleCallbackQuery(cb, env) {
  const data = cb.data || '';
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const msgId = cb.message.message_id;

  const [action, ...params] = data.split(':');
  const param = params.join(':');

  try {
    if (action === 'trigger_type') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期，请重新 /create', env);
      const wizard = JSON.parse(raw);
      wizard.data.triggerType = param; // 'time' 或 'count'
      wizard.step = 6;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      if (param === 'time') {
        await editMsg(chatId, msgId, `⏰ **定时开奖**\n\n请输入开奖时间（格式：\`2024-12-25 20:00\`，24小时制）：`, env);
      } else {
        await editMsg(chatId, msgId, `👥 **人数开奖**\n\n请输入参与人数上限（到达后自动开奖，例如：\`50\`）：`, env);
      }
      return answerCb(cb.id, '', env);
    }

    if (action === 'select_group') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);
      const wizard = JSON.parse(raw);
      const groupId = parseInt(param);
      const groups = await getBotGroups(env);
      const g = groups.find(x => x.id === groupId);
      wizard.data.groupId = groupId;
      wizard.data.groupName = g?.title || '';
      wizard.step = 8;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const channelKb = [
        [{ text: '⏭️ 跳过（不发布到频道）', callback_data: 'skip_channel' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      await editMsg(chatId, msgId, `✅ 发布群：\`${groupId}\`${g?.title ? `（${esc(g.title)}）` : ''}\n\n📢 第8步（可选）：请输入**频道**链接或用户名\n例如：\`@mychannel\`\n公告会同时发布到该频道（并可设为强制加频道）\n（点击跳过则只发布到群）`, env, channelKb);
      return answerCb(cb.id, '✅ 已选择', env);
    }

    if (action === 'skip_channel') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);
      const wizard = JSON.parse(raw);
      wizard.data.channel = '';
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      await editMsg(chatId, msgId, '⏭️ 已跳过，只发布到群', env);
      await finishWizard(chatId, msgId, userId, wizard, env);
      return answerCb(cb.id, '✅ 跳过', env);
    }

    if (action === 'cancel_wizard') {
      const wizardKey = `wizard:${userId}`;
      await env.LOTTERY_KV.delete(wizardKey);
      await editMsg(chatId, msgId, '❌ 已取消创建', env);
      return answerCb(cb.id, '已取消', env);
    }

    await answerCb(cb.id, '', env);
  } catch (err) {
    console.error('Callback error:', err);
    await answerCb(cb.id, '处理出错', env);
  }
}

// ==================== 完成创建 ====================

async function finishWizard(chatId, msgId, userId, wizard, env) {
  // 生成抽奖 ID
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const lotteryId = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 8);

  const now = Date.now();
  const lottery = {
    id: lotteryId,
    groupId: wizard.data.groupId,
    groupName: wizard.data.groupName,
    creatorId: userId,
    name: wizard.data.name,
    prize: wizard.data.prize,
    winnerCount: wizard.data.winnerCount || 1,
    keyword: wizard.data.keyword,
    triggerType: wizard.data.triggerType,
    triggerValue: wizard.data.triggerValue,
    channel: wizard.data.channel || '',
    participants: [],
    participantNames: {},
    winners: [],
    status: 'active',
    createdAt: now,
    drawnAt: null,
  };

  if (!lottery.groupId) {
    return sendMessage(chatId, '❌ 未选择发布群，创建失败。请重新 /create。', env);
  }

  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  await addToGroupIndex(env, lottery.groupId, lotteryId);
  if (lottery.triggerType === 'time') await addToScheduled(env, lotteryId);

  // 删除向导状态
  await env.LOTTERY_KV.delete(`wizard:${userId}`);

  // 校验 bot 是否在发布群内（不在则提示，不发公告）
  const botInGroup = await checkBotInChat(lottery.groupId, env);

  const triggerText = lottery.triggerType === 'time'
    ? `⏰ 开奖时间：${fmtDate(lottery.triggerValue)}`
    : `👥 满 ${lottery.triggerValue} 人自动开奖`;

  const channelText = lottery.channel
    ? `\n📢 频道：${lottery.channel}`
    : '';

  // 发布到群
  const groupPost = `🎊 **抽奖开始啦！** 🎊

━━━━━━━━━━━━━━━━
📝 **活动名称：** ${esc(lottery.name)}
🎁 **奖品：** ${esc(lottery.prize)}
🏆 **中奖名额：** ${lottery.winnerCount} 人
${triggerText}${channelText}
━━━━━━━━━━━━━━━━

🔑 在群内发送口令 \`${lottery.keyword}\` 即可参与抽奖！`;

  if (botInGroup) {
    await sendMessage(lottery.groupId, groupPost, env);
  }

  // 发布到频道（如有）
  if (lottery.channel) {
    try { await sendMessage(lottery.channel, groupPost, env); } catch {}
  }

  // 私聊给创建者确认
  const botWarn = botInGroup
    ? ''
    : `\n⚠️ **机器人不在发布群中**，公告未能发布！\n请把机器人加入该群（设为管理员）后，手动发送公告或在私聊中使用 /groups 检查。`;

  const confirmText = `✅ **创建成功！**

🆔 **ID：** \`${lottery.id}\`
📢 **发布群：** \`${lottery.groupId}\`${lottery.groupName ? `（${esc(lottery.groupName)}）` : ''}
${lottery.channel ? `📢 **频道：** ${lottery.channel}` : ''}
🔑 **口令：** \`${lottery.keyword}\`
${botWarn}
💡 查看抽奖：\`/list\` · 手动开奖：\`/draw ${lottery.id}\` · 取消：\`/cancel ${lottery.id}\``;

  if (msgId) {
    await editMsg(chatId, msgId, confirmText, env);
  } else {
    await sendMessage(chatId, confirmText, env);
  }
}

// ==================== 口令参与 ====================

async function checkKeyword(chatId, userId, username, text, chatTitle, env) {
  // 查找该群所有进行中的抽奖
  const indexData = await env.LOTTERY_KV.get(`group:${chatId}:lotteries`);
  if (!indexData) return;

  const ids = JSON.parse(indexData);
  const now = Date.now();

  for (const id of ids) {
    const raw = await env.LOTTERY_KV.get(`lottery:${id}`);
    if (!raw) continue;
    const lottery = JSON.parse(raw);
    if (lottery.status !== 'active') continue;

    // 检查定时开奖（每次有人发消息时检查）
    if (lottery.triggerType === 'time' && now >= lottery.triggerValue) {
      if (lottery.participants.length === 0) {
        lottery.status = 'cancelled';
        await env.LOTTERY_KV.put(`lottery:${id}`, JSON.stringify(lottery));
        await sendMessage(chatId, `⏰ 开奖时间已到，但「${esc(lottery.name)}」无人参与，已自动取消`, env);
        continue;
      }
      await executeDraw(id, lottery, env, chatTitle);
      continue;
    }

    // 检查口令
    if (text.trim() !== lottery.keyword) continue;

    // 检查是否已参与
    if (lottery.participants.includes(userId)) {
      return sendMessage(chatId, `⚠️ ${esc(username)}，你已经参与过「${esc(lottery.name)}」了，请等待开奖结果~`, env);
    }

    // 检查频道（强制加频道）
    if (lottery.channel) {
      const isMember = await checkChannelMembership(lottery.channel, userId, env);
      if (!isMember) {
        return sendMessage(chatId, `❌ ${esc(username)}，请先加入频道 ${lottery.channel} 后再参与抽奖！`, env);
      }
    }

    // 加入参与者
    lottery.participants.push(userId);
    lottery.participantNames[userId] = username;
    const count = lottery.participants.length;
    await env.LOTTERY_KV.put(`lottery:${id}`, JSON.stringify(lottery));

    await sendMessage(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯`, env);

    // 检查是否需要自动开奖（人数到达）
    if (lottery.triggerType === 'count' && count >= lottery.triggerValue) {
      await executeDraw(id, lottery, env, chatTitle);
    }

    return;
  }
}

async function checkChannelMembership(channel, userId, env) {
  const channelName = channel.replace('@', '').trim();
  if (!channelName) return true;

  try {
    const res = await tgApi(env, 'getChatMember', {
      chat_id: `@${channelName}`,
      user_id: userId,
    });
    if (!res.ok) return false;
    const status = res.result.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}
// ==================== 开奖 ====================

async function drawLottery(chatId, userId, lotteryId, env, chatTitle) {
  if (!lotteryId) {
    return sendMessage(chatId, '❌ 请提供抽奖ID\n用法：`/draw <抽奖ID>`', env);
  }
  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);

  const lottery = JSON.parse(raw);
  if (userId !== lottery.creatorId) {
    return sendMessage(chatId, '❌ 只有创建者才能开奖', env);
  }
  if (lottery.status !== 'active') {
    return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  }
  if (lottery.participants.length === 0) {
    return sendMessage(chatId, '😢 暂无人参与，无法开奖', env);
  }

  return executeDraw(lotteryId, lottery, env, chatTitle);
}

async function executeDraw(lotteryId, lottery, env, chatTitle) {
  const participants = lottery.participants;
  const winnerCount = Math.min(lottery.winnerCount || 1, participants.length);
  const winners = securePick(participants, winnerCount);

  lottery.status = 'completed';
  lottery.winners = winners;
  lottery.drawnAt = Date.now();
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  await removeFromScheduled(env, lotteryId);

  const winnerNames = winners.map(id => lottery.participantNames[id] || `用户${id}`);

  // 群内公告
  const winnerList = winnerNames.map((n, i) => `${i + 1}. @${esc(n)}`).join('\n');
  const groupText = `🎊🎊🎊 **开奖啦！** 🎊🎊🎊

━━━━━━━━━━━━━━━━━━
📝 **活动：** ${esc(lottery.name)}
🎁 **奖品：** ${esc(lottery.prize)}
👥 **参与人数：** ${participants.length} 人
🏆 **中奖人数：** ${winnerCount} 人
━━━━━━━━━━━━━━━━━━

🎉 **中奖者：**
${winnerList}

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
  await sendMessage(lottery.groupId, groupText, env);
  if (lottery.channel) {
    try { await sendMessage(lottery.channel, groupText, env); } catch {}
  }

  // 私信通知中奖者
  for (const winnerId of winners) {
    const name = lottery.participantNames[winnerId] || `用户${winnerId}`;
    const dmText = `🥳🥳 **恭喜中奖啦！** 🥳🥳

━━━━━━━━━━━━━━━━
**抽奖群：** ${esc(chatTitle || lottery.groupName)}
**活动名称：** ${esc(lottery.name)}
**获得奖品：** ${esc(lottery.prize)}
━━━━━━━━━━━━━━━━

『联系该群管理领取您的奖品吧~』

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
    try { await sendMessage(winnerId, dmText, env); }
    catch { console.log(`Cannot DM ${winnerId}`); }
  }

  // 通知创建者
  const creatorList = winnerNames.map((n, i) => `${i + 1}- ${n}  获得:${esc(lottery.prize)}`).join('\n');
  const creatorText = `💐💐💐 **开奖了** 💐💐💐

**${esc(lottery.name)}** 开奖了!
本期总参与人数: ${participants.length}

${creatorList}

谨祝中奖用户大吉大利万事顺意`;
  try { await sendMessage(lottery.creatorId, creatorText, env); }
  catch { console.log(`Cannot DM creator ${lottery.creatorId}`); }
}

// ==================== 取消 / 列表 ====================

async function cancelLotteryCmd(chatId, userId, lotteryId, env, chatTitle) {
  if (!lotteryId) return sendMessage(chatId, '❌ 用法：`/cancel <抽奖ID>`', env);
  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);
  const lottery = JSON.parse(raw);
  if (userId !== lottery.creatorId) return sendMessage(chatId, '❌ 只有创建者才能取消', env);
  if (lottery.status !== 'active') return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  lottery.status = 'cancelled';
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  await removeFromScheduled(env, lotteryId);
  return sendMessage(chatId, `✅ 抽奖 \`${lotteryId}\` 已取消`, env);
}

async function listLotteries(chatId, env, chatTitle, userId) {
  // 私聊：返回我创建的所有进行中抽奖；群聊：返回本群抽奖
  const isPrivate = chatId > 0;
  let active = [];

  if (isPrivate) {
    const groups = await getBotGroups(env);
    for (const g of groups) {
      const indexData = await env.LOTTERY_KV.get(`group:${g.id}:lotteries`);
      if (!indexData) continue;
      const ids = JSON.parse(indexData);
      for (const id of ids) {
        const raw = await env.LOTTERY_KV.get(`lottery:${id}`);
        if (!raw) continue;
        const l = JSON.parse(raw);
        if (l.status === 'active' && (l.creatorId === userId || !userId)) active.push(l);
      }
    }
  } else {
    const indexData = await env.LOTTERY_KV.get(`group:${chatId}:lotteries`);
    if (indexData) {
      const ids = JSON.parse(indexData);
      for (const id of ids) {
        const raw = await env.LOTTERY_KV.get(`lottery:${id}`);
        if (raw) {
          const l = JSON.parse(raw);
          if (l.status === 'active') active.push(l);
        }
      }
    }
  }
  if (active.length === 0) return sendMessage(chatId, '📭 当前没有进行中的抽奖', env);
  let text = '📋 **进行中的抽奖：**\n\n';
  active.forEach((l, i) => {
    const trigger = l.triggerType === 'time' ? `⏰ ${fmtDate(l.triggerValue)}` : `👥 ${l.participants.length}/${l.triggerValue}人`;
    text += `${i + 1}. **${esc(l.name)}**\n`;
    text += `   🆔 \`${l.id}\` · 🎁 ${esc(l.prize)} · 👥 ${l.participants.length}人 · ${trigger}\n\n`;
  });
  return sendMessage(chatId, text, env);
}

// ==================== 管理命令：刷新群列表 ====================

async function refreshGroupsCmd(chatId, userId, env) {
  const groups = await getBotGroups(env);
  if (groups.length === 0) {
    return sendMessage(chatId, '🤖 我还没有加入任何群组。\n\n请把机器人**加入目标群组**（设为管理员），然后再次发送 /groups。', env);
  }
  const list = groups.map(g => `• \`${g.id}\` ${g.title ? `（${esc(g.title)}）` : ''}`).join('\n');
  return sendMessage(chatId, `🤖 我已加入的群组（${groups.length} 个）：\n\n${list}`, env);
}

// ==================== 工具函数 ====================

function securePick(arr, count) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    let rand = 0;
    for (let b = 0; b < 4; b++) rand = (rand << 8) | buf[b];
    const j = Math.abs(rand % (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function fmtDate(ts) {
  const d = new Date(ts);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// 检查 bot 是否在该 chat 内（getChatMember 用 bot 自己的 token 取 bot id）
async function checkBotInChat(chatId, env) {
  try {
    const botToken = env.BOT_TOKEN || '';
    const botId = botToken.split(':')[0];
    if (!botId) return false;
    const res = await tgApi(env, 'getChatMember', {
      chat_id: chatId,
      user_id: parseInt(botId),
    });
    if (!res.ok) return false;
    return ['member', 'administrator', 'creator', 'restricted'].includes(res.result.status);
  } catch {
    return false;
  }
}

async function addToGroupIndex(env, groupId, lotteryId) {
  const raw = await env.LOTTERY_KV.get(`group:${groupId}:lotteries`);
  let ids = raw ? JSON.parse(raw) : [];
  ids = ids.filter(id => id !== lotteryId);
  ids.unshift(lotteryId);
  ids = ids.slice(0, 50);
  await env.LOTTERY_KV.put(`group:${groupId}:lotteries`, JSON.stringify(ids));
}

// ==================== Telegram API ====================

async function tgApi(env, method, body, retries = 3) {
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
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '1');
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      console.warn(`TG ${method} error:`, data);
      return data;
    } catch (err) {
      console.warn(`TG ${method} attempt ${i + 1}:`, err);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 200 * 2 ** i));
      else throw err;
    }
  }
}

async function sendMessage(chatId, text, env) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

async function sendMsgKb(chatId, text, kb, env) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: kb },
  });
}

async function editMsg(chatId, msgId, text, env, kb) {
  return tgApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
  });
}

async function answerCb(cbId, text, env) {
  return tgApi(env, 'answerCallbackQuery', { callback_query_id: cbId, text });
}
