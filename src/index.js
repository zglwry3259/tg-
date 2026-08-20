/**
 * 群组管家 v6.6 - Cloudflare Workers
 * 抽奖模块（私聊创建+多奖品+发布置顶+口令参与+定时/人数开奖+私信通知+中奖兑奖）
 * + 入群验证模块 + 管理员公告模块 + 投票模块
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
    await loadTzOffset(env);
    ctx.waitUntil(checkScheduledDraws(env));
    ctx.waitUntil(checkPendingVerifications(env));
    // 首次自动设置指令菜单（只需一次）
    ctx.waitUntil(ensureCommands(env));
  },
};

// ==================== 定时开奖（Cron） ====================

// 首次运行时自动设置 Bot 指令菜单（setMyCommands），KV 标记只执行一次
async function ensureCommands(env) {
  try {
    const flag = await env.LOTTERY_KV.get('commands_set_v7');
    if (flag === '1') return;

    const token = env.BOT_TOKEN || '';
    const url = `${TELEGRAM_API}/bot${token}/setMyCommands`;
    const privateCommands = [
      { command: 'create', description: '✨ 创建抽奖（10步向导）' },
      { command: 'announce', description: '📢 发布群公告（私聊发起）' },
      { command: 'poll', description: '📊 发起群投票（私聊发起）' },
      { command: 'list', description: '📋 查看我创建的抽奖' },
      { command: 'draw', description: '🎲 手动开奖 用法: /draw <ID>' },
      { command: 'cancel', description: '❌ 取消抽奖 用法: /cancel <ID>' },
      { command: 'groups', description: '🤖 查看可发布群组' },
      { command: 'start', description: '📖 帮助说明' },
    ];
    const groupCommands = [
      { command: 'list', description: '📋 查看本群抽奖' },
      { command: 'draw', description: '🎲 手动开奖 用法: /draw <ID>' },
      { command: 'cancel', description: '❌ 取消抽奖 用法: /cancel <ID>' },
      { command: 'verify', description: '🛡️ 入群验证开关: /verify on|off' },
      { command: 'mute', description: '🔇 禁言: 回复+ /mute 1h' },
      { command: 'kick', description: '👢 踢出: 回复+ /kick' },
      { command: 'ban', description: '🚫 封禁: 回复+ /ban' },
      { command: 'warn', description: '⚠️ 警告: 回复+ /warn' },
      { command: 'rules', description: '📜 查看/设置群规' },
      { command: 'welcome', description: '👋 设置欢迎语' },
      { command: 'admins', description: '🛡️ 管理员列表' },
      { command: 'info', description: 'ℹ️ 群信息' },
    ];

    // 私聊（默认 scope）
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: privateCommands }),
    });
    // 群聊 scope
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { type: 'all_group_chats' }, commands: groupCommands }),
    });

    await env.LOTTERY_KV.put('commands_set_v7', '1');
    console.log('Bot commands menu set.');
  } catch (err) {
    console.error('ensureCommands error:', err);
  }
}

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
  await loadTzOffset(env);
  if (update.message) await handleMessage(update.message, env);
  else if (update.callback_query) await handleCallbackQuery(update.callback_query, env);
  else if (update.my_chat_member) await handleMyChatMember(update.my_chat_member, env);
  else if (update.chat_member) await handleChatMember(update.chat_member, env);
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
      const deepLink = (args[0] || '').toLowerCase();
      if (deepLink.startsWith('verify_')) {
        return handleVerifyStart(chatId, userId, deepLink, env);
      }
      if (deepLink === 'notify' || deepLink === '开启提醒') {
        return sendMessage(chatId, '🔔 **中奖私信提醒已开启！**\n\n以后你参与的抽奖开奖后，中奖结果会第一时间私信通知你～\n（本提示仅需开启一次，之后所有抽奖自动生效）', env);
      }
      if (deepLink === 'redeem' || deepLink === '兑奖') {
        return handleRedeemStart(chatId, userId, env);
      }
      const menuKb = [
        [{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '📢 发布公告', callback_data: 'menu:announce' }],
        [{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📋 我的抽奖', callback_data: 'menu:list' }],
        [{ text: '⚙️ 设置群组', callback_data: 'menu:groups' }, { text: '⚙️ 设置频道', callback_data: 'menu:channels' }],
        [{ text: '🌏 设置时区', callback_data: 'menu:timezone' }],
      ];
      return sendMsgKb(chatId, '🎉 **群组管家 v6.6**\n\n📌 所有功能都在**私聊**向我发起：\n\n✨ 创建抽奖（多奖品/兑奖码） · 📢 发布公告（自动置顶）\n📊 发起投票 · 📋 我的抽奖（内联键盘）\n⚙️ 设置默认群组 / 频道 · 🌏 时区', menuKb, env);
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
    if (cmdLower === '/announce' || cmdLower === '/notice') {
      return announceCmd(chatId, userId, args.join(' '), env, chatTitle);
    }
    if (cmdLower === '/poll' || cmdLower === '/vote') {
      return pollCmd(chatId, args.join(' '), env);
    }
    if (cmdLower === '/verify') {
      return verifyCmd(chatId, userId, args[0] || '', env);
    }
    // 群管命令：mute/kick/ban/warn/del/pin/rules/welcome/lock 等（仅在群聊中生效）
    if (MOD_CMD_LIST.includes(cmdLower)) {
      return handleModCmd(chatId, userId, cmdLower, args.join(' '), msg, chatTitle, env);
    }
    return;
  }

  // ---- 私聊：验证答案 / 向导步骤 / 投票 / 公告 草稿 ----
  if (chatType === 'private') {
    // 有进行中的入群加减法验证 → 优先当答案处理
    const handledVerify = await tryVerifyAnswer(chatId, userId, text, env);
    if (handledVerify) return;
    // 公告待输入：把本条消息当公告内容
    const announcePending = await env.LOTTERY_KV.get(`announce_pending:${userId}`);
    if (announcePending) {
      await env.LOTTERY_KV.delete(`announce_pending:${userId}`);
      return announceCmd(chatId, userId, text, env, chatTitle);
    }
    // 投票待输入：把本条消息当投票内容
    const pollPending = await env.LOTTERY_KV.get(`poll_pending:${chatId}`);
    if (pollPending) {
      await env.LOTTERY_KV.delete(`poll_pending:${chatId}`);
      return pollCmd(chatId, text, env);
    }
    // 投票草稿：等待选择发布群（可点按钮或手动输入群ID）
    const pollDraft = await env.LOTTERY_KV.get(`poll_draft:${chatId}`);
    if (pollDraft) {
      return resolvePollGroup(chatId, text, env);
    }
    // 公告草稿：等待选择发布群
    const announceDraft = await env.LOTTERY_KV.get(`announce_draft:${chatId}`);
    if (announceDraft) {
      return resolveAnnounceGroup(chatId, text, env);
    }
    return handleWizardStep(chatId, userId, text, env);
  }

  // ---- 群聊：检查口令 ----
  if (chatType === 'group' || chatType === 'supergroup') {
    return checkKeyword(chatId, userId, username, text, chatTitle, env);
  }
}

// ==================== Bot 入群记录（发布目标群/频道列表） ====================

async function handleMyChatMember(mcm, env) {
  const chat = mcm.chat;
  if (!chat) return;
  const isChannel = chat.type === 'channel';
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (!isGroup && !isChannel) return;
  const newStatus = mcm.new_chat_member?.status || '';

  const key = isChannel ? 'bot_channels' : 'bot_groups';
  const raw = await env.LOTTERY_KV.get(key);
  let list = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(list)) list = [];

  const idx = list.findIndex(g => g.id === chat.id);
  if (newStatus === 'left' || newStatus === 'kicked') {
    if (idx >= 0) list.splice(idx, 1);
  } else if (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'restricted') {
    const g = { id: chat.id, title: chat.title || (isChannel ? `频道${chat.id}` : `群${chat.id}`) };
    if (idx >= 0) list[idx] = g;
    else list.push(g);
  }
  await env.LOTTERY_KV.put(key, JSON.stringify(list));
}

async function getBotGroups(env) {
  const raw = await env.LOTTERY_KV.get('bot_groups');
  if (!raw) return [];
  const groups = JSON.parse(raw);
  return Array.isArray(groups) ? groups : [];
}

async function getBotChannels(env) {
  const raw = await env.LOTTERY_KV.get('bot_channels');
  if (!raw) return [];
  const channels = JSON.parse(raw);
  return Array.isArray(channels) ? channels : [];
}

// 用户设置（默认群/默认频道）
async function getUserCfg(userId, env) {
  const raw = await env.LOTTERY_KV.get(`user_cfg:${userId}`);
  if (!raw) return { defaultGroupId: null, defaultChannelId: null };
  try { return JSON.parse(raw); } catch { return { defaultGroupId: null, defaultChannelId: null }; }
}

// 设置页：选择默认群组
async function showSettingsGroups(chatId, msgId, env, userId) {
  const groups = await getBotGroups(env);
  const cfg = await getUserCfg(userId, env);
  const kb = [];
  for (const g of groups.slice(0, 15)) {
    const mark = cfg.defaultGroupId === g.id ? ' ⭐' : '';
    kb.push([{ text: `📢 ${esc(g.title || g.id)}${mark}`, callback_data: `set_group:${g.id}` }]);
  }
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  if (groups.length === 0) {
    await editMsg(chatId, msgId, '⚠️ **还未找到可发布群组**\n\n请先把机器人**加入目标群组**（并设为管理员），bot 会自动记录。', env, kb);
    return;
  }
  await editMsg(chatId, msgId, `⚙️ **设置默认发布群组**\n\n点击选择一个群组作为默认发布目标（⭐ 为当前默认）：`, env, kb);
}

// 设置页：选择默认频道
async function showSettingsChannels(chatId, msgId, env, userId) {
  const channels = await getBotChannels(env);
  const cfg = await getUserCfg(userId, env);
  const kb = [];
  for (const c of channels.slice(0, 15)) {
    const mark = cfg.defaultChannelId === c.id ? ' ⭐' : '';
    kb.push([{ text: `📣 ${esc(c.title || c.id)}${mark}`, callback_data: `set_channel:${c.id}` }]);
  }
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  if (channels.length === 0) {
    await editMsg(chatId, msgId, '⚠️ **还未找到频道**\n\n请先把机器人**加入目标频道**（并设为管理员），bot 会自动记录。', env, kb);
    return;
  }
  await editMsg(chatId, msgId, `⚙️ **设置默认发布频道**\n\n点击选择一个频道作为默认发布目标（⭐ 为当前默认）：`, env, kb);
}

// 设置页：选择时区
async function showSettingsTimezone(chatId, msgId, env, userId) {
  const names = [
    { label: '🇨🇳 北京时间 (UTC+8)', val: '8' },
    { label: '🇯🇵 东京时间 (UTC+9)', val: '9' },
    { label: '🇹🇭 曼谷时间 (UTC+7)', val: '7' },
    { label: '🌐 UTC (UTC+0)', val: '0' },
    { label: '🇺🇸 纽约时间 (UTC-5)', val: '-5' },
  ];
  const kb = names.map(n => [{ text: n.label, callback_data: `set_timezone:${n.val}` }]);
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  const tzNames = { 8: '北京时间', 9: '东京时间', 0: 'UTC', 7: '曼谷时间', '-5': '纽约时间' };
  await editMsg(chatId, msgId, `🌏 **设置时区**\n\n当前时区：**${tzNames[TZ_OFFSET_HOURS] || `UTC${TZ_OFFSET_HOURS >= 0 ? '+' : ''}${TZ_OFFSET_HOURS}`}**\n\n开奖时间会按所选时区显示：`, env, kb);
}

// ==================== 入群验证 ====================

// 群聊/频道成员变动：新成员加入时触发入群验证
async function handleChatMember(mcm, env) {
  const chat = mcm.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;

  const newMember = mcm.new_chat_member;
  const userId = newMember?.user?.id;
  if (!userId) return;

  // bot 自己加入时由 my_chat_member 处理，跳过
  const botId = parseInt((env.BOT_TOKEN || '').split(':')[0]);
  if (userId === botId) return;

  const oldStatus = mcm.old_chat_member?.status || '';
  const newStatus = newMember.status || '';

  // 只处理真正的成员加入（left/kicked → member），避免解除禁言(restricted→member)等误判
  if (oldStatus !== 'left' && oldStatus !== 'kicked') return;
  if (newStatus !== 'member' && newStatus !== 'restricted') return;

  // 读取该群验证开关（默认开启）
  const cfgRaw = await env.LOTTERY_KV.get(`verify_cfg:${chat.id}`);
  let cfg = { enabled: true };
  if (cfgRaw) {
    try { cfg = JSON.parse(cfgRaw); } catch {}
  }
  if (!cfg.enabled) {
    // 验证关闭：直接发自定义欢迎语（若设置了）
    await sendWelcomeIfSet(chat.id, newMember.user.username || newMember.user.first_name || `用户${userId}`, env);
    return;
  }

  // 检查 bot 是否有管理员权限（能否禁言/踢人）
  const botAdmin = await isBotAdmin(chat.id, env);

  const name = newMember.user.username || newMember.user.first_name || `用户${userId}`;

  // 禁言新成员（若 bot 是管理员）
  let muted = false;
  if (botAdmin) {
    const rest = await tgApi(env, 'restrictChatMember', {
      chat_id: chat.id,
      user_id: userId,
      permissions: allPermissionsObject(false),
      until_date: Math.floor(Date.now() / 1000) + 600, // 10分钟后自动解除
    }).catch(() => null);
    muted = !!(rest && rest.ok);
  }

  // 记录待验证
  const vKey = `verify_pending:${chat.id}:${userId}`;
  const pending = {
    chatId: chat.id,
    userId,
    name,
    muted,
    joinedAt: Date.now(),
    msgId: null,
    stage: 'idle',       // idle=待开始 / quiz=题目已出待作答
    question: '',
    answer: null,
    attempts: 0,
  };
  await env.LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });

  // 发送验证提示消息（若有自定义欢迎语则合并，不单独发送）——点击按钮跳转 bot 私聊进行加减法验证
  const welcomeText = await getWelcomeText(chat.id, name, env);
  const text = `👋 欢迎 **${esc(name)}** 加入本群！${welcomeText ? `\n\n${welcomeText}` : ''}\n\n🧮 为防广告/骚扰，请点击下方按钮**跳转到机器人进行加减法验证**，10分钟内未验证将被移出群聊。`;
  const botUn = await getBotUsername(env);
  const verifyUrl = botUn ? `https://t.me/${botUn}?start=verify_${chat.id}_${userId}` : null;
  const kb = verifyUrl
    ? [[{ text: '🧮 点击验证（加减法）', url: verifyUrl }]]
    : [[{ text: '✅ 点我通过验证', callback_data: `verify_join:${chat.id}:${userId}` }]];
  const res = await sendMsgKb(chat.id, text, kb, env).catch(() => null);
  if (res && res.ok && res.result?.message_id) {
    pending.msgId = res.result.message_id;
    await env.LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });
  }
}

// 每分钟检查：超时未验证的成员，移出群聊
async function checkPendingVerifications(env) {
  try {
    const list = await env.LOTTERY_KV.list({ prefix: 'verify_pending:' });
    if (!list.keys || list.keys.length === 0) return;

    const now = Date.now();
    for (const k of list.keys) {
      const raw = await env.LOTTERY_KV.get(k.name);
      if (!raw) continue;
      let pending;
      try { pending = JSON.parse(raw); } catch { continue; }
      if (now - pending.joinedAt < 10 * 60 * 1000) continue; // 未超时

      // 超过10分钟未验证 → 踢出（无权限踢不动则静默清理记录）
      const kicked = await kickUser(pending.chatId, pending.userId, env);
      await env.LOTTERY_KV.delete(k.name);
      if (pending.msgId) {
        await tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: pending.msgId }).catch(() => null);
      }
      if (kicked) {
        await sendMessage(pending.chatId, `🚫 **${esc(pending.name || `用户${pending.userId}`)}** 未在10分钟内完成入群验证，已被移出群聊。`, env).catch(() => null);
      }
    }
  } catch (err) {
    console.error('checkPendingVerifications error:', err);
  }
}

// 踢出用户（ban + unban）
async function kickUser(chatId, userId, env) {
  try {
    await tgApi(env, 'banChatMember', { chat_id: chatId, user_id: userId });
    await tgApi(env, 'unbanChatMember', { chat_id: chatId, user_id: userId });
    return true;
  } catch {
    return false;
  }
}

// bot 是否是群管理员
async function isBotAdmin(chatId, env) {
  try {
    const botId = parseInt((env.BOT_TOKEN || '').split(':')[0]);
    if (!botId) return false;
    const res = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: botId });
    if (!res.ok) return false;
    return ['administrator', 'creator'].includes(res.result.status);
  } catch {
    return false;
  }
}

// 权限对象（restrictChatMember 用） whole=true 全部放行 / false 全部禁止（禁言）
function allPermissionsObject(whole) {
  const perms = {
    can_send_messages: whole,
    can_send_audios: whole,
    can_send_documents: whole,
    can_send_photos: whole,
    can_send_videos: whole,
    can_send_video_notes: whole,
    can_send_voice_notes: whole,
    can_send_polls: whole,
    can_send_other_messages: whole,
    can_add_web_page_previews: whole,
    can_change_info: whole,
    can_invite_users: whole,
    can_pin_messages: whole,
  };
  return perms;
}

// ==================== 管理员公告（私聊发起） ====================

// /announce：私聊发起 → 提示输入内容 → 选择发布群 → bot 发公告并置顶
async function announceCmd(chatId, userId, text, env, chatTitle) {
  if (chatId < 0) {
    return sendMessage(chatId, '📢 发布公告请**私聊机器人**：\n\n直接发送 `/announce`，按提示输入公告内容。\n\n发布后自动置顶，并校验你是目标群管理员。', env);
  }
  const content = (text || '').trim();
  if (!content) {
    // 进入待输入状态：下一条消息作为公告内容
    await env.LOTTERY_KV.put(`announce_pending:${userId}`, '1', { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'cancel_announce_pending' }]];
    return sendMsgKb(chatId, '📢 **管理员公告**\n\n请直接发送**公告内容**：\n\n💡 示例：`本周六晚8点群活动，欢迎参加！`', kb, env);
  }
  if (content.length > 1000) {
    return sendMessage(chatId, '❌ 公告过长（≤1000字），请精简后重试', env);
  }

  // 存草稿 → 选择发布群
  const draftKey = `announce_draft:${userId}`;
  await env.LOTTERY_KV.put(draftKey, JSON.stringify({ userId, content }), { expirationTtl: 900 });
  return showGroupPicker(chatId, env, 'announce_publish');
}

// 群选择按钮回调：发布公告
async function publishAnnounce(chatId, userId, targetGroupId, msgId, env) {
  const draftKey = `announce_draft:${userId}`;
  const raw = await env.LOTTERY_KV.get(draftKey);
  // 先清理草稿
  await env.LOTTERY_KV.delete(draftKey);

  // 校验发起者是目标群管理员
  const status = await getChatMemberStatus(targetGroupId, userId, env);
  if (status !== 'creator' && status !== 'administrator') {
    await editMsg(chatId, msgId, '❌ 你不是该群的管理员，无法在此群发布公告。', env);
    return { ok: false, reason: 'not_admin' };
  }

  const draft = raw ? JSON.parse(raw) : null;
  if (!draft || !draft.content) {
    await editMsg(chatId, msgId, '⏰ 公告草稿已过期，请重新发送 `/announce` 再输入内容', env);
    return { ok: false, reason: 'expired' };
  }

  const post = `📢 **群公告**\n\n${draft.content}\n\n— ${'群管理组'}`;
  const res = await sendMessage(targetGroupId, post, env);
  if (res && res.ok && res.result?.message_id) {
    // 自动置顶
    await tgApi(env, 'pinChatMessage', { chat_id: targetGroupId, message_id: res.result.message_id, disable_notification: true }).catch(() => null);
    await editMsg(chatId, msgId, `✅ 公告已发布并置顶！\n\n📢 发布群：\`${targetGroupId}\``, env);
    return { ok: true };
  }
  await editMsg(chatId, msgId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return { ok: false, reason: 'send_failed' };
}

// ==================== 投票（私聊发起） ====================

// /poll：私聊发起 → 提示输入内容 → 选择发布群 → bot 在群里发原生投票
async function pollCmd(chatId, text, env) {
  if (chatId < 0) {
    return sendMessage(chatId, '📊 发起投票请**私聊机器人**：\n\n直接发送 `/poll`，按提示输入投票内容。', env);
  }
  if (!(text || '').trim()) {
    // 进入待输入状态：下一条消息作为投票内容
    await env.LOTTERY_KV.put(`poll_pending:${chatId}`, '1', { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'cancel_poll_pending' }]];
    return sendMsgKb(chatId, '📊 **发起投票**\n\n请直接发送：`问题|选项1|选项2|...`\n\n💡 示例：`今晚吃什么？|火锅|烧烤|日料`\n⚡ 多选：`--multi 喜欢哪些？|A|B|C`\n📌 需要 问题 + 至少2个选项', kb, env);
  }

  let multi = false;
  let body = (text || '').trim();
  const flagMatch = body.match(/^--(multi|anonymous|open)\b/);
  if (flagMatch) {
    multi = flagMatch[1] === 'multi';
    body = body.replace(flagMatch[0], '').trim();
  }

  const parts = body.replace(/｜/g, '|').split('|').map(s => s.trim());
  if (parts.length < 3) {
    return sendMessage(chatId, '❌ 格式错误：至少需要 问题 + 2 个选项\n用法：`/poll 问题|选项1|选项2`', env);
  }

  const question = parts[0];
  const options = parts.slice(1);
  if (question.length > 300) return sendMessage(chatId, '❌ 问题过长（≤300字）', env);
  if (options.length > 10) return sendMessage(chatId, '❌ 选项最多10个', env);
  for (const o of options) {
    if (o.length > 100) return sendMessage(chatId, '❌ 单个选项不能超过100字', env);
  }

  // 存草稿 → 选择发布群
  const draftKey = `poll_draft:${chatId}`;
  await env.LOTTERY_KV.put(draftKey, JSON.stringify({ userId: chatId, question, options, multi }), { expirationTtl: 900 });
  return showGroupPicker(chatId, env, 'poll_publish');
}

// 群选择按钮回调：发布投票
async function publishPoll(chatId, userId, targetGroupId, msgId, env) {
  const draftKey = `poll_draft:${userId}`;
  const raw = await env.LOTTERY_KV.get(draftKey);
  await env.LOTTERY_KV.delete(draftKey);

  const draft = raw ? JSON.parse(raw) : null;
  if (!draft || !draft.question) {
    await editMsg(chatId, msgId, '⏰ 投票草稿已过期，请重新发送 `/poll` 再输入内容', env);
    return { ok: false, reason: 'expired' };
  }

  const res = await tgApi(env, 'sendPoll', {
    chat_id: targetGroupId,
    question: draft.question,
    options: draft.options,
    is_anonymous: true,
    allows_multiple_answers: draft.multi,
  });
  if (res && res.ok) {
    await editMsg(chatId, msgId, `✅ 投票已发布到群 \`${targetGroupId}\`！\n\n📊 **${esc(draft.question)}**`, env);
    return { ok: true };
  }
  await editMsg(chatId, msgId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return { ok: false, reason: 'send_failed' };
}

// ==================== 群选择辅助 ====================

// 展示可发布群列表（按钮）供用户选择；无群时提示手动输入
async function showGroupPicker(chatId, env, actionPrefix) {
  const groups = await getBotGroups(env);
  const cfg = await getUserCfg(chatId, env);
  // 默认群排最前并标注 ⭐
  if (cfg.defaultGroupId) {
    const idx = groups.findIndex(g => g.id === cfg.defaultGroupId);
    if (idx > 0) {
      const [def] = groups.splice(idx, 1);
      groups.unshift(def);
    }
  }
  const kb = [];
  for (const g of groups.slice(0, 12)) {
    const isDef = cfg.defaultGroupId === g.id;
    kb.push([{ text: `${isDef ? '⭐ ' : ''}📢 ${esc(g.title || g.id)}`, callback_data: `${actionPrefix}:${g.id}` }]);
  }
  kb.push([{ text: '❌ 取消', callback_data: 'cancel_group_pick' }]);
  return sendMsgKb(chatId, `📤 **选择发布群**\n\n点选下方群组（最多显示12个），或直接输入群 ID / t.me 链接：`, kb, env);
}

// 手动输入群ID/链接时的解析
async function resolveTargetGroupId(text) {
  const t = (text || '').trim();
  if (/^-?\d{5,}$/.test(t)) return parseInt(t);
  const m = t.match(/t\.me\/([A-Za-z0-9_]+)/);
  if (m) return m[1]; // 返回 username，供 resolve 时确认
  if (/^@[A-Za-z0-9_]{3,}$/.test(t)) return t.slice(1);
  return null;
}

// 手动输入群ID：公告（无回调消息可编辑，直接发回复）
async function resolveAnnounceGroup(chatId, text, env) {
  const resolved = await resolveTargetGroupId(text);
  if (!resolved || typeof resolved === 'string') {
    return sendMessage(chatId, '⚠️ 无法识别群标识，请发送群 ID（负整数，如 `-1001234567890`）或 t.me 链接。');
  }
  const status = await getChatMemberStatus(resolved, chatId, env);
  if (status !== 'creator' && status !== 'administrator') {
    await env.LOTTERY_KV.delete(`announce_draft:${chatId}`);
    return sendMessage(chatId, '❌ 你不是该群的管理员，无法在此群发布公告。');
  }
  const raw = await env.LOTTERY_KV.get(`announce_draft:${chatId}`);
  await env.LOTTERY_KV.delete(`announce_draft:${chatId}`);
  if (!raw) return sendMessage(chatId, '⏰ 公告草稿已过期，请重新发送 `/announce` 再输入内容');
  const draft = JSON.parse(raw);
  const post = `📢 **群公告**\n\n${draft.content}\n\n— ${'群管理组'}`;
  const res = await sendMessage(resolved, post, env);
  if (res && res.ok && res.result?.message_id) {
    await tgApi(env, 'pinChatMessage', { chat_id: resolved, message_id: res.result.message_id, disable_notification: true }).catch(() => null);
    await sendMessage(chatId, `✅ 公告已发布并置顶！\n\n📢 发布群：\`${resolved}\``, env);
    return null;
  }
  await sendMessage(chatId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return null;
}

// 手动输入群ID：投票
async function resolvePollGroup(chatId, text, env) {
  const resolved = await resolveTargetGroupId(text);
  if (!resolved || typeof resolved === 'string') {
    return sendMessage(chatId, '⚠️ 无法识别群标识，请发送群 ID（负整数，如 `-1001234567890`）或 t.me 链接。');
  }
  const raw = await env.LOTTERY_KV.get(`poll_draft:${chatId}`);
  await env.LOTTERY_KV.delete(`poll_draft:${chatId}`);
  if (!raw) return sendMessage(chatId, '⏰ 投票草稿已过期，请重新发送 `/poll` 再输入内容');
  const draft = JSON.parse(raw);
  const res = await tgApi(env, 'sendPoll', {
    chat_id: resolved,
    question: draft.question,
    options: draft.options,
    is_anonymous: true,
    allows_multiple_answers: draft.multi,
  });
  if (res && res.ok) {
    await sendMessage(chatId, `✅ 投票已发布到群 \`${resolved}\`！\n\n📊 **${draft.question}**`, env);
    return null;
  }
  await sendMessage(chatId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return null;
}

// ==================== 其他 ====================

// ==================== 入群验证开关 ====================

// 生成一道加减法题目（结果一定非负）
function genQuiz() {
  const op = Math.random() < 0.5 ? '+' : '-';
  let a = 1 + Math.floor(Math.random() * 50);
  let b = 1 + Math.floor(Math.random() * 50);
  if (op === '-' && b > a) { const t = a; a = b; b = t; }
  const answer = op === '+' ? a + b : a - b;
  return { question: `${a} ${op} ${b}`, answer };
}

// 深链：t.me/bot?start=verify_<chatId>_<userId> → 私聊开始加减法验证
async function handleVerifyStart(chatId, userId, deepLink, env) {
  if (chatId < 0) {
    return sendMessage(chatId, '🧮 请**私聊机器人**完成入群验证：\n\n打开 @' + (deepLink.replace('verify_', '')) + ' 或从群内验证消息点按钮，在私聊里回答问题即可。', env);
  }
  const parts = deepLink.split('_');
  if (parts.length < 3) return sendMessage(chatId, '❌ 无效的验证链接，请从群内验证消息重新点按钮', env);
  const targetUserId = parseInt(parts[parts.length - 1]);
  const targetChatId = parseInt(parts.slice(1, -1).join(''));
  if (!targetChatId || !targetUserId) return sendMessage(chatId, '❌ 无效的验证链接', env);

  // 校验点击者就是待验证用户本人
  if (userId !== targetUserId) {
    return sendMessage(chatId, `⚠️ 请**本人**（用户 ${targetUserId}）点击验证链接完成入群验证。`, env);
  }

  const vKey = `verify_pending:${targetChatId}:${targetUserId}`;
  const vRaw = await env.LOTTERY_KV.get(vKey);
  if (!vRaw) {
    return sendMessage(chatId, '⏳ 该验证已过期或已完成。\n\n如果你仍然在群里但被禁言，请联系管理员处理。', env);
  }
  const pending = JSON.parse(vRaw);

  // 生成题目
  const { question, answer } = genQuiz();
  pending.stage = 'quiz';
  pending.question = question;
  pending.answer = answer;
  pending.attempts = 0;
  await env.LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });

  const name = pending.name || `用户${targetUserId}`;
  const qText = `🧮 **入群加减法验证**\n\n👋 你好 **${esc(name)}**！\n\n请回答下面的算术题以完成验证（答错可重试，最多3次）：\n\n**${question} = ?**\n\n📝 直接回复**答案数字**即可。`;
  return sendMessage(chatId, qText, env);
}

// 私聊收到文本：如果该用户有待完成的验证，把文本当答案处理
async function tryVerifyAnswer(chatId, userId, text, env) {
  if (chatId < 0) return false;
  let matchedKey = null;
  let pending = null;
  try {
    const list = await env.LOTTERY_KV.list({ prefix: 'verify_pending:' });
    for (const k of list.keys || []) {
      const raw = await env.LOTTERY_KV.get(k.name);
      if (!raw) continue;
      let p;
      try { p = JSON.parse(raw); } catch { continue; }
      if (p.userId === userId && p.stage === 'quiz') {
        matchedKey = k.name;
        pending = p;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!pending) return false;

  // 解析答案：优先识别 "a + b" / "a - b" 表达式，否则提取纯数字
  let answerNum = NaN;
  const plusM = (text || '').match(/(\d+)\s*\+\s*(\d+)/);
  const minusM = (text || '').match(/(\d+)\s*-\s*(\d+)/);
  if (plusM) answerNum = parseInt(plusM[1], 10) + parseInt(plusM[2], 10);
  else if (minusM) answerNum = parseInt(minusM[1], 10) - parseInt(minusM[2], 10);
  else answerNum = parseInt((text || '').replace(/[^\d-]/g, ''), 10);
  const displayName = pending.name || `用户${userId}`;

  if (!isNaN(answerNum) && answerNum === pending.answer) {
    // ✅ 答对：解除禁言 + 清理记录 + 删除群内提示 + 通知
    if (pending.muted) {
      await tgApi(env, 'restrictChatMember', {
        chat_id: pending.chatId,
        user_id: userId,
        permissions: allPermissionsObject(true),
      }).catch(() => {});
    }
    await env.LOTTERY_KV.delete(matchedKey);
    if (pending.msgId) {
      await tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: pending.msgId }).catch(() => {});
    }
    await sendMessage(chatId, `✅ 验证成功！**${esc(displayName)}** 已解除禁言，欢迎加入本群～ 🎉`, env);
    await sendMessage(pending.chatId, `✅ **${esc(displayName)}** 已完成加减法验证，欢迎加入本群！🎉`, env).catch(() => {});
    return true;
  }

  // ❌ 答错
  pending.attempts = (pending.attempts || 0) + 1;
  if (pending.attempts >= 3) {
    // 超过3次换新题
    const { question, answer } = genQuiz();
    pending.question = question;
    pending.answer = answer;
    pending.attempts = 0;
    await env.LOTTERY_KV.put(matchedKey, JSON.stringify(pending), { expirationTtl: 660 });
    await sendMessage(chatId, `❌ 已连续答错 3 次，已为你更换新题：\n\n**${question} = ?**\n\n📝 直接回复答案数字即可。`, env);
    return true;
  }
  await env.LOTTERY_KV.put(matchedKey, JSON.stringify(pending), { expirationTtl: 660 });
  await sendMessage(chatId, `❌ 答案不对哦，请再想想（剩余 ${3 - pending.attempts} 次机会）：\n\n**${pending.question} = ?**`, env);
  return true;
}

// /verify on|off：群管理员开启/关闭入群验证；无参数查看状态
async function verifyCmd(chatId, userId, arg, env) {
  if (chatId > 0) {
    return sendMessage(chatId, '❌ 请在群聊中使用：`/verify on|off`', env);
  }
  const admin = await getChatMemberStatus(chatId, userId, env);
  if (admin !== 'creator' && admin !== 'administrator') {
    return sendMessage(chatId, '❌ 只有群管理员才能设置入群验证', env);
  }

  const cfgKey = `verify_cfg:${chatId}`;
  const cfgRaw = await env.LOTTERY_KV.get(cfgKey);
  let cfg = { enabled: true };
  if (cfgRaw) {
    try { cfg = JSON.parse(cfgRaw); } catch {}
  }

  const a = (arg || '').toLowerCase();
  if (a === 'on' || a === '1' || a === '开') {
    cfg.enabled = true;
    await env.LOTTERY_KV.put(cfgKey, JSON.stringify(cfg));
    return sendMessage(chatId, '✅ 入群验证已开启：新成员需点击验证按钮后方可发言。', env);
  }
  if (a === 'off' || a === '0' || a === '关') {
    cfg.enabled = false;
    await env.LOTTERY_KV.put(cfgKey, JSON.stringify(cfg));
    return sendMessage(chatId, '⛔ 入群验证已关闭。', env);
  }
  return sendMessage(chatId, `🛡️ 入群验证当前状态：**${cfg.enabled ? '开启 ✅' : '关闭 ❌'}**\n\n用法：\`/verify on\` 开启 · \`/verify off\` 关闭`, env);
}

// 获取成员身份：creator / administrator / member / ...
async function getChatMemberStatus(chatId, userId, env) {
  try {
    const res = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: userId });
    if (res.ok && res.result?.status) return res.result.status;
  } catch {}
  return '';
}

// ==================== 群组管理（管理员命令） ====================

const MOD_CMD_LIST = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/unwarn', '/warns', '/warnings', '/del', '/pin', '/unpin', '/settitle', '/welcome', '/rules', '/lock', '/unlock', '/admins', '/adminlist', '/info', '/groupinfo'];

// 时间解析：1m=1分钟 10m=10分钟 1h=1小时 1d=1天 永久=forever
function parseMuteTime(arg) {
  const a = (arg || '').trim().toLowerCase();
  if (!a) return { seconds: 60 * 60, label: '1小时', forever: false }; // 默认1小时
  if (a === 'forever' || a === '永久' || a === '0') return { seconds: 0, label: '永久', forever: true };
  const m = a.match(/^(\d+)\s*(s|秒|m|分|分钟|h|时|小时|d|天)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2];
  let seconds;
  if (unit === 's' || unit === '秒') seconds = n;
  else if (unit === 'm' || unit === '分' || unit === '分钟') seconds = n * 60;
  else if (unit === 'h' || unit === '时' || unit === '小时') seconds = n * 60 * 60;
  else if (unit === 'd' || unit === '天') seconds = n * 24 * 60 * 60;
  return { seconds, label: a, forever: n <= 0 };
}

// 读取/写入 群配置（欢迎语/群规/全员禁言）
async function getGroupCfg(chatId, env) {
  const raw = await env.LOTTERY_KV.get(`group_cfg:${chatId}`);
  if (!raw) return { welcome: '', rules: '', lock: false };
  try { return JSON.parse(raw); } catch { return { welcome: '', rules: '', lock: false }; }
}

function isAdminStatus(s) {
  return s === 'creator' || s === 'administrator';
}

// 读取欢迎语文本（{name} 替换）；未设置返回 null
async function getWelcomeText(chatId, name, env) {
  try {
    const cfg = await getGroupCfg(chatId, env);
    if (!cfg.welcome) return null;
    return cfg.welcome.replace(/\{name\}/g, name);
  } catch { return null; }
}

// 新成员欢迎语（验证关闭时单独发送）
async function sendWelcomeIfSet(chatId, name, env) {
  try {
    const text = await getWelcomeText(chatId, name, env);
    if (!text) return null;
    return sendMessage(chatId, text, env);
  } catch { return null; }
}

// 群管命令统一入口
async function handleModCmd(chatId, userId, cmd, arg, msg, chatTitle, env) {
  if (chatId > 0) {
    return sendMessage(chatId, '❌ 群管命令请在群聊中使用。', env);
  }
  const isAdmin = await getChatMemberStatus(chatId, userId, env);
  if (!isAdminStatus(isAdmin)) {
    return sendMessage(chatId, '❌ 只有群管理员才能使用群管命令', env);
  }
  const botAdmin = await isBotAdmin(chatId, env);

  // 回复目标用户（mute/kick/ban/warn/del/pin 针对被回复的人）
  const replyUser = msg.reply_to_message?.from ? msg.reply_to_message.from : null;

  if (cmd === '/admins' || cmd === '/adminlist') {
    try {
      const res = await tgApi(env, 'getChatAdministrators', { chat_id: chatId });
      if (!res.ok) return sendMessage(chatId, '❌ 获取管理员列表失败', env);
      const lines = res.result.map((a, i) => {
        const u = a.user;
        const name = u.username ? `@${u.username}` : (u.first_name || `用户${u.id}`);
        const role = a.status === 'creator' ? '👑 群主' : '🛡️ 管理员';
        return `${i + 1}. ${role} ${esc(name)}`;
      });
      return sendMessage(chatId, `🛡️ **管理员列表**（${lines.length}）\n\n${lines.join('\n')}`, env);
    } catch { return sendMessage(chatId, '❌ 获取管理员列表失败', env); }
  }

  if (cmd === '/info' || cmd === '/groupinfo') {
    try {
      const [chatRes, memRes, admRes] = await Promise.all([
        tgApi(env, 'getChat', { chat_id: chatId }),
        tgApi(env, 'getChatMemberCount', { chat_id: chatId }),
        tgApi(env, 'getChatAdministrators', { chat_id: chatId }),
      ]);
      const title = chatRes.ok ? (chatRes.result.title || chatTitle) : chatTitle;
      const members = memRes.ok ? memRes.result : '?';
      const admins = admRes.ok ? admRes.result.length : '?';
      return sendMessage(chatId, `ℹ️ **群信息**\n\n📢 群名：${esc(title)}\n👥 成员：${members}\n🛡️ 管理员：${admins}\n🆔 ID：\`${chatId}\`\n🤖 bot 管理员权限：${botAdmin ? '✅ 有' : '❌ 无（部分功能不可用）'}`, env);
    } catch { return sendMessage(chatId, '❌ 获取群信息失败', env); }
  }

  if (cmd === '/settitle') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能修改群标题', env);
    const title = (arg || '').trim();
    if (!title || title.length > 128) return sendMessage(chatId, '❌ 请输入群标题（≤128字符）', env);
    const res = await tgApi(env, 'setChatTitle', { chat_id: chatId, title });
    return res.ok ? sendMessage(chatId, `✅ 群标题已改为：**${esc(title)}**`, env) : sendMessage(chatId, '❌ 修改失败（权限不足？）', env);
  }

  if (cmd === '/welcome') {
    const a = (arg || '').trim();
    if (!a) {
      const cfg = await getGroupCfg(chatId, env);
      return sendMessage(chatId, `👋 **欢迎语**：${cfg.welcome ? `\n\n${cfg.welcome}` : '（未设置）'}\n\n设置：\`/welcome 文本\`（\`{name}\` 代表新成员名）\n关闭：\`/welcome off\``, env);
    }
    const cfg = await getGroupCfg(chatId, env);
    if (a.toLowerCase() === 'off' || a === '关') {
      cfg.welcome = '';
      await env.LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
      return sendMessage(chatId, '🚫 欢迎语已关闭', env);
    }
    if (a.length > 500) return sendMessage(chatId, '❌ 欢迎语过长（≤500字）', env);
    cfg.welcome = a;
    await env.LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, `✅ 欢迎语已设置：\n\n${a}\n\n新成员加入时会自动发送（\`{name}\` 自动替换为成员名）。`, env);
  }

  if (cmd === '/rules') {
    const a = (arg || '').trim();
    if (!a) {
      const cfg = await getGroupCfg(chatId, env);
      return sendMessage(chatId, `📜 **群规**：${cfg.rules ? `\n\n${cfg.rules}` : '（未设置）'}\n\n设置：\`/rules 群规内容\``, env);
    }
    const cfg = await getGroupCfg(chatId, env);
    if (a.length > 2000) return sendMessage(chatId, '❌ 群规过长（≤2000字）', env);
    cfg.rules = a;
    await env.LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, `✅ 群规已设置：\n\n${a}`, env);
  }

  if (cmd === '/lock' || cmd === '/unlock') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能设置全员禁言', env);
    const lock = cmd === '/lock';
    const res = await tgApi(env, 'setChatPermissions', { chat_id: chatId, permissions: allPermissionsObject(!lock) });
    if (!res.ok) return sendMessage(chatId, '❌ 设置失败（权限不足？）', env);
    const cfg = await getGroupCfg(chatId, env);
    cfg.lock = lock;
    await env.LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, lock ? '🔒 全员禁言已开启（除管理员外禁止发言）' : '🔓 全员禁言已解除', env);
  }

  // 以下命令需要回复目标消息
  if (!replyUser) {
    return sendMessage(chatId, '❌ 请**回复**目标用户的消息来使用该命令', env);
  }
  const targetId = replyUser.id;
  const targetName = replyUser.username ? `@${replyUser.username}` : (replyUser.first_name || `用户${targetId}`);

  if (cmd === '/del' || cmd === '/delete') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能删除消息', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => null);
    return res && res.ok ? null : sendMessage(chatId, '❌ 删除失败', env);
  }

  if (cmd === '/pin') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能置顶', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'pinChatMessage', { chat_id: chatId, message_id: msgId, disable_notification: true }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, '📌 已置顶该消息', env) : sendMessage(chatId, '❌ 置顶失败（权限不足？）', env);
  }

  if (cmd === '/unpin') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能取消置顶', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'unpinChatMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, '📍 已取消置顶', env) : sendMessage(chatId, '❌ 取消置顶失败', env);
  }

  // 禁言
  if (cmd === '/mute') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能禁言', env);
    const parsed = parseMuteTime(arg);
    if (!parsed) return sendMessage(chatId, '❌ 时间格式错误，支持：`1m` `30m` `1h` `1d` `永久`\n示例：`/mute 1h`（回复目标）', env);
    const body = {
      chat_id: chatId,
      user_id: targetId,
      permissions: allPermissionsObject(false),
    };
    if (!parsed.forever) body.until_date = Math.floor(Date.now() / 1000) + parsed.seconds;
    const res = await tgApi(env, 'restrictChatMember', body).catch(() => null);
    return res && res.ok
      ? sendMessage(chatId, `🔇 **${esc(targetName)}** 已被禁言 ${parsed.label}${parsed.forever ? '' : ''}`, env)
      : sendMessage(chatId, '❌ 禁言失败（目标已是管理员？权限不足？）', env);
  }

  if (cmd === '/unmute') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能解除禁言', env);
    const res = await tgApi(env, 'restrictChatMember', { chat_id: chatId, user_id: targetId, permissions: allPermissionsObject(true) }).catch(() => null);
    return res && res.ok
      ? sendMessage(chatId, `🔊 **${esc(targetName)}** 已被解除禁言`, env)
      : sendMessage(chatId, '❌ 解除禁言失败', env);
  }

  // 踢出（ban + unban）
  if (cmd === '/kick') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能踢出', env);
    const res = await kickUser(chatId, targetId, env);
    return res ? sendMessage(chatId, `👢 **${esc(targetName)}** 已被移出群聊`, env) : sendMessage(chatId, '❌ 踢出失败（权限不足？）', env);
  }

  // 封禁
  if (cmd === '/ban') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能封禁', env);
    const res = await tgApi(env, 'banChatMember', { chat_id: chatId, user_id: targetId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `🚫 **${esc(targetName)}** 已被封禁（无法再加入）`, env) : sendMessage(chatId, '❌ 封禁失败', env);
  }

  if (cmd === '/unban') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能解封', env);
    const res = await tgApi(env, 'unbanChatMember', { chat_id: chatId, user_id: targetId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `✅ **${esc(targetName)}** 已解除封禁`, env) : sendMessage(chatId, '❌ 解封失败', env);
  }

  // 警告系统：3次自动踢出
  if (cmd === '/warn') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await env.LOTTERY_KV.get(warnKey);
    let count = raw ? parseInt(raw) : 0;
    count += 1;
    await env.LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    const reason = (arg || '').trim();
    if (count >= 3) {
      await env.LOTTERY_KV.delete(warnKey);
      let kicked = false;
      if (botAdmin) kicked = await kickUser(chatId, targetId, env);
      return sendMessage(chatId, `⚠️ **${esc(targetName)}** 警告次数已达 3 次${kicked ? '，已被移出群聊' : ''}！${reason ? `\n原因：${reason}` : ''}`, env);
    }
    return sendMessage(chatId, `⚠️ **${esc(targetName)}** 警告（${count}/3）${reason ? `\n原因：${reason}` : ''}\n满 3 次将自动移出群聊`, env);
  }

  if (cmd === '/unwarn') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await env.LOTTERY_KV.get(warnKey);
    if (!raw) return sendMessage(chatId, `ℹ️ **${esc(targetName)}** 当前没有警告记录`, env);
    const count = parseInt(raw) - 1;
    if (count <= 0) await env.LOTTERY_KV.delete(warnKey);
    else await env.LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    return sendMessage(chatId, `✅ **${esc(targetName)}** 警告已撤销，当前 ${Math.max(count, 0)}/3`, env);
  }

  if (cmd === '/warns' || cmd === '/warnings') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await env.LOTTERY_KV.get(warnKey);
    const count = raw ? parseInt(raw) : 0;
    return sendMessage(chatId, `📋 **${esc(targetName)}** 当前警告：${count}/3`, env);
  }

  return null;
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
    data: { name: '', prize: '', prizes: [], winnerCount: 1, keyword: '', triggerType: '', triggerValue: null, channel: '', groupId: null, groupName: '', useCodes: false, codes: [] },
  };
  await env.LOTTERY_KV.put(`wizard:${userId}`, JSON.stringify(wizard), { expirationTtl: 3600 });

  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];
  return sendMsgKb(chatId, `🎯 **抽奖创建向导**（第1步/共10步）\n\n📝 请输入**抽奖活动名称**：`, kb, env);
}

// 第7步：选择发布群（按钮）— 供「输入时间/人数」和「快捷时间按钮」复用
async function showWizardGroupPicker(chatId, userId, wizard, confirmText, env) {
  const wizardKey = `wizard:${userId}`;
  wizard.step = 7;
  await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];
  const groups = await getBotGroups(env);
  if (groups.length === 0) {
    return sendMsgKb(chatId, `⚠️ **还未找到可发布群**\n\n请先把机器人**加入目标群组**（并设为管理员），然后发送 \`/groups\` 刷新，或直接输入群 ID（如 \`-1001234567890\`）。`, kb, env);
  }
  const cfg = await getUserCfg(userId, env);
  if (cfg.defaultGroupId) {
    const idx = groups.findIndex(g => g.id === cfg.defaultGroupId);
    if (idx > 0) {
      const [def] = groups.splice(idx, 1);
      groups.unshift(def);
    }
  }
  const groupKb = [];
  for (const g of groups.slice(0, 12)) {
    const isDef = cfg.defaultGroupId === g.id;
    groupKb.push([{ text: `${isDef ? '⭐ ' : ''}📢 ${esc(g.title || g.id)}`, callback_data: `select_group:${g.id}` }]);
  }
  groupKb.push([{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]);
  return sendMsgKb(chatId, `✅ ${confirmText}\n\n📢 第7步：请选择**公告发布群**（公告发到该群，参与也在此群）：`, groupKb, env);
}

// 第9步：兑换码开关（按钮）
async function showCodeToggle(chatId, userId, wizard, env) {
  const wizardKey = `wizard:${userId}`;
  wizard.step = 9;
  await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

  const kb = [
    [{ text: '✅ 是，填写兑换码', callback_data: 'code_mode:yes' },
     { text: '🚫 否，不需要', callback_data: 'code_mode:no' }],
    [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
  ];
  return sendMsgKb(chatId, `✅ 频道：${wizard.data.channel ? `\`${esc(wizard.data.channel)}\`` : '未设置（只发群）'}\n\n🎟️ 第9步：中奖后是否**直接通过 bot 发送兑换码**给中奖者？\n\n💡 选择「是」后，下一步请粘贴兑换码列表（每行一个），开奖时会按中奖名单逐个私信发放。`, kb, env);
}

async function handleWizardStep(chatId, userId, text, env) {
  const wizardKey = `wizard:${userId}`;
  const raw = await env.LOTTERY_KV.get(wizardKey);
  if (!raw) return;

  const wizard = JSON.parse(raw);
  if (wizard.step < 1 || wizard.step > 10) return;

  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];

  switch (wizard.step) {
    case 1: // 活动名称
      wizard.data.name = text;
      wizard.step = 2;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 活动名称：**${esc(text)}**\n\n🎁 第2步：请输入**奖品名称**：`, kb, env);

    case 2: { // 奖品（支持多个：回复奖品名后点「继续添加/结束添加」）
      const first = (wizard.data.prizes || []).length === 0;
      wizard.data.prizes = wizard.data.prizes || [];
      wizard.data.prizes.push(text.trim());
      wizard.data.prize = wizard.data.prizes.join('、');
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const prizeKb = [
        [{ text: '➕ 继续添加', callback_data: 'prize_add' },
         { text: '⏭️ 结束添加', callback_data: 'prize_done' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      const listText = wizard.data.prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n');
      return sendMsgKb(chatId, `✅ 已添加奖品${first ? '' : '（追加）'}：\n${listText}\n\n🎁 请回复**下一个奖品名称**继续添加，或点击按钮结束：\n\n💡 多个奖品将按中奖顺序一一对应发放。`, prizeKb, env);
    }

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
        let targetTime = parseRelativeTime(text);
        if (targetTime === null) {
          const timeMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
          if (!timeMatch) {
            return sendMsgKb(chatId, '❌ 时间格式错误，请输入：\n`10分钟后` / `1小时后` / `1天后` / `1周后`\n或具体时间：`2026-08-25 20:00`', kb, env);
          }
          const [, y, m, d, h, min] = timeMatch;
          targetTime = parseLocalTime(y, m, d, h, min);
        }
        if (targetTime <= Date.now()) {
          return sendMsgKb(chatId, '❌ 开奖时间必须在当前时间之后', kb, env);
        }
        wizard.data.triggerValue = targetTime;
      } else {
        const count = parseInt(text);
        if (isNaN(count) || count < 2 || count > 1000) {
          return sendMsgKb(chatId, '❌ 请输入2~1000之间的数字', kb, env);
        }
        wizard.data.triggerValue = count;
      }

      const confirmText = wizard.data.triggerType === 'time'
        ? `开奖时间：\`${fmtDate(wizard.data.triggerValue)}\``
        : `人数上限：\`${wizard.data.triggerValue}\``;
      return showWizardGroupPicker(chatId, userId, wizard, confirmText, env);

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
      wizard.step = 9;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return showCodeToggle(chatId, userId, wizard, env);

    case 10: // 兑换码列表（每行一个）
      const codeLines = text.split('\n').map(s => s.replace(/[｜|,，、]/g, '\n').split('\n')).flat().map(s => s.trim()).filter(Boolean);
      if (codeLines.length === 0) {
        return sendMsgKb(chatId, '❌ 请输入至少一个兑换码（每行一个）：', kb, env);
      }
      wizard.data.useCodes = true;
      wizard.data.codes = codeLines;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      if (codeLines.length < wizard.data.winnerCount) {
        // 码少：警告但仍允许（开奖时未配发的会标注联系管理员）
        await sendMessage(chatId, `⚠️ 兑换码数量（${codeLines.length}）少于中奖名额（${wizard.data.winnerCount}）\n开奖时未配发到码的中奖者将提示联系管理员。`, env);
      }
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
    // ============ 主菜单（/start 内联键盘） ============
    if (action === 'menu') {
      if (param === 'create') {
        await startWizard(chatId, userId, '', '', env);
        return answerCb(cb.id, '', env);
      }
      if (param === 'announce') {
        await env.LOTTERY_KV.put(`announce_pending:${userId}`, '1', { expirationTtl: 900 });
        const kb = [[{ text: '❌ 取消', callback_data: 'cancel_announce_pending' }]];
        await editMsg(chatId, msgId, '📢 **管理员公告**\n\n请直接发送**公告内容**：\n\n💡 示例：`本周六晚8点群活动，欢迎参加！`', env, kb);
        return answerCb(cb.id, '', env);
      }
      if (param === 'poll') {
        await env.LOTTERY_KV.put(`poll_pending:${chatId}`, '1', { expirationTtl: 900 });
        const kb = [[{ text: '❌ 取消', callback_data: 'cancel_poll_pending' }]];
        await editMsg(chatId, msgId, '📊 **发起投票**\n\n请直接发送：`问题|选项1|选项2|...`\n\n💡 示例：`今晚吃什么？|火锅|烧烤|日料`\n⚡ 多选：`--multi 喜欢哪些？|A|B|C`', env, kb);
        return answerCb(cb.id, '', env);
      }
      if (param === 'list') {
        await listLotteries(chatId, env, '', userId, msgId);
        return answerCb(cb.id, '', env);
      }
      if (param === 'groups') {
        await showSettingsGroups(chatId, msgId, env, userId);
        return answerCb(cb.id, '', env);
      }
      if (param === 'channels') {
        await showSettingsChannels(chatId, msgId, env, userId);
        return answerCb(cb.id, '', env);
      }
      if (param === 'timezone') {
        await showSettingsTimezone(chatId, msgId, env, userId);
        return answerCb(cb.id, '', env);
      }
    }

    // ============ 设置：选择群组 / 频道 / 时区 ============
    if (action === 'set_group') {
      const groupId = parseInt(param);
      await env.LOTTERY_KV.put(`user_cfg:${userId}`, JSON.stringify({ ...(await getUserCfg(userId, env)), defaultGroupId: groupId }));
      const groups = await getBotGroups(env);
      const g = groups.find(x => x.id === groupId);
      await editMsg(chatId, msgId, `✅ 默认发布群已设置为：\`${g?.title || groupId}\`\n\n以后创建抽奖/公告/投票会优先选中该群。`, env);
      return answerCb(cb.id, '✅ 已设置', env);
    }

    if (action === 'set_channel') {
      const channelId = parseInt(param);
      await env.LOTTERY_KV.put(`user_cfg:${userId}`, JSON.stringify({ ...(await getUserCfg(userId, env)), defaultChannelId: channelId }));
      const channels = await getBotChannels(env);
      const c = channels.find(x => x.id === channelId);
      await editMsg(chatId, msgId, `✅ 默认发布频道已设置为：\`${c?.title || channelId}\``, env);
      return answerCb(cb.id, '✅ 已设置', env);
    }

    if (action === 'set_timezone') {
      const hours = parseInt(param);
      if (isNaN(hours)) return answerCb(cb.id, '无效时区', env);
      await env.LOTTERY_KV.put('bot_timezone', String(hours));
      TZ_OFFSET_HOURS = hours;
      const names = { '8': '北京时间 (UTC+8)', '9': '东京时间 (UTC+9)', '0': 'UTC (UTC+0)', '7': '曼谷时间 (UTC+7)', '-5': '纽约时间 (UTC-5)' };
      await editMsg(chatId, msgId, `✅ 时区已设置为：**${names[hours] || `UTC${hours >= 0 ? '+' : ''}${hours}`}**\n\n所有开奖时间将按该时区显示。`, env);
      return answerCb(cb.id, '✅ 已设置', env);
    }

    // ============ 主菜单：返回 ============
    if (action === 'menu_back') {
      const menuKb = [
        [{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '📢 发布公告', callback_data: 'menu:announce' }],
        [{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📋 我的抽奖', callback_data: 'menu:list' }],
        [{ text: '⚙️ 设置群组', callback_data: 'menu:groups' }, { text: '⚙️ 设置频道', callback_data: 'menu:channels' }],
        [{ text: '🌏 设置时区', callback_data: 'menu:timezone' }],
      ];
      await editMsg(chatId, msgId, '🎉 **群组管家 v6.6**\n\n📌 所有功能都在**私聊**向我发起：\n\n✨ 创建抽奖（多奖品/兑奖码） · 📢 发布公告（自动置顶）\n📊 发起投票 · 📋 我的抽奖（内联键盘）\n⚙️ 设置默认群组 / 频道 · 🌏 时区', env, menuKb);
      return answerCb(cb.id, '', env);
    }

    if (action === 'prize_add') { // 继续添加奖品：保持 step2 等待下一条消息
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);
      const wizard = JSON.parse(raw);
      wizard.step = 2;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      await editMsg(chatId, msgId, '🎁 请回复**下一个奖品名称**（回复后自动继续添加，或点下方按钮结束）：', env, [
        [{ text: '⏭️ 结束添加', callback_data: 'prize_done' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ]);
      return answerCb(cb.id, '继续添加', env);
    }

    if (action === 'prize_done') { // 结束添加奖品 → 进入第3步
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);
      const wizard = JSON.parse(raw);
      wizard.data.prize = (wizard.data.prizes || []).join('、');
      wizard.step = 3;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const prizeList = (wizard.data.prizes || []).map((p, i) => `${i + 1}. ${esc(p)}`).join('\n');
      const manyHint = (wizard.data.prizes || []).length > 1 ? `\n\n⚠️ 多个奖品时，建议中奖名额与奖品数量一致，将按中奖顺序一一发放。` : '';
      await editMsg(chatId, msgId, `✅ 奖品已确认：\n${prizeList}${manyHint}\n\n🏆 第3步：请输入**中奖名额数量**（默认1人）：`, env, [
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ]);
      return answerCb(cb.id, '已确认', env);
    }

    if (action === 'redeem') {
      const lotteryId = param;
      const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
      if (!raw) return answerCb(cb.id, '该抽奖记录已不存在', env);
      const lottery = JSON.parse(raw);
      const winnerIdx = (lottery.winners || []).indexOf(userId);
      if (winnerIdx === -1) {
        return answerCb(cb.id, '你不是该抽奖的中奖者', env);
      }
      const prizes = (lottery.prizes && lottery.prizes.length) ? lottery.prizes : [lottery.prize || '奖品'];
      const myPrize = prizes[Math.min(winnerIdx, prizes.length - 1)];
      const myCode = lottery.useCodes && Array.isArray(lottery.codes) ? lottery.codes[winnerIdx] : null;
      const text = myCode
        ? `🎟️ **兑奖成功！**\n\n🎁 奖品：${esc(myPrize)}\n🎟️ 兑奖码：\`${esc(myCode)}\`\n\n📌 请把此码发给管理员完成兑换～`
        : `🎟️ 兑奖信息\n\n🎁 奖品：${esc(myPrize)}\n\n📌 请私聊管理员领取奖品并在群内出示中奖通知～`;
      await sendMessage(chatId, text, env);
      // 从待兑名单移除本条
      const redeemKey = `my_redeem:${userId}`;
      const rawR = await env.LOTTERY_KV.get(redeemKey);
      if (rawR) {
        try {
          const list = JSON.parse(rawR).filter(x => x.lotteryId !== lotteryId);
          await env.LOTTERY_KV.put(redeemKey, JSON.stringify(list));
        } catch {}
      }
      // 通知创建者兑奖完成
      const creator = lottery.creatorId;
      if (creator && creator !== userId) {
        try {
          await sendMessage(creator, `🎟️ **玩家已完成兑奖**\n\n📝 抽奖：${esc(lottery.name)}\n🎁 奖品：${esc(myPrize)}\n👤 中奖者：\`${userId}\`${myCode ? `\n🎟️ 兑奖码：\`${esc(myCode)}\`` : ''}`, env);
        } catch {}
      }
      return answerCb(cb.id, '✅ 兑奖成功', env);
    }

    if (action === 'redeem_clear') {
      await env.LOTTERY_KV.put(`my_redeem:${userId}`, JSON.stringify([]));
      await editMsg(chatId, msgId, '🎟️ 已清空待兑奖记录 ✅', env);
      return answerCb(cb.id, '已清空', env);
    }

    if (action === 'lot_view') {
      await showLotteryDetail(chatId, userId, msgId, param, env);
      return answerCb(cb.id, '', env);
    }

    if (action === 'lot_draw') {
      const raw = await env.LOTTERY_KV.get(`lottery:${param}`);
      if (!raw) return answerCb(cb.id, '抽奖不存在', env);
      const l = JSON.parse(raw);
      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能开奖', env);
      if (l.status !== 'active') return answerCb(cb.id, '抽奖已结束', env);
      if (!l.participants || l.participants.length === 0) return answerCb(cb.id, '暂无人参与', env);
      await executeDraw(param, l, env, l.groupName || '');
      return answerCb(cb.id, '🎲 已开奖', env);
    }

    if (action === 'lot_end') {
      const raw = await env.LOTTERY_KV.get(`lottery:${param}`);
      if (!raw) return answerCb(cb.id, '抽奖不存在', env);
      const l = JSON.parse(raw);
      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能结束', env);
      if (l.status !== 'active') return answerCb(cb.id, '抽奖已结束', env);
      const yesKb = [
        [{ text: '✅ 确认结束', callback_data: `lot_end_confirm:${param}` }],
        [{ text: '↩️ 返回详情', callback_data: `lot_view:${param}` }],
      ];
      await editMsg(chatId, msgId, `⚠️ **确认结束本次抽奖？**\n\n📝 ${esc(l.name)}\n👥 已参与 ${l.participants ? l.participants.length : 0} 人\n\n结束后不可恢复，参与者将收到取消通知。`, env, yesKb);
      return answerCb(cb.id, '', env);
    }

    if (action === 'lot_end_confirm') {
      const raw = await env.LOTTERY_KV.get(`lottery:${param}`);
      if (!raw) return answerCb(cb.id, '抽奖不存在', env);
      const l = JSON.parse(raw);
      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能结束', env);
      // 取消逻辑
      l.status = 'cancelled';
      l.cancelledAt = Date.now();
      await env.LOTTERY_KV.put(`lottery:${param}`, JSON.stringify(l));
      if (l.groupMsgId) {
        try { await tgApi(env, 'unpinChatMessage', { chat_id: l.groupId, message_id: l.groupMsgId }); } catch {}
      }
      // 通知参与者
      const cancelText = `❌ 「${esc(l.name)}」已结束（未开奖）\n\n感谢参与，下次好运～`;
      for (const pid of (l.participants || [])) {
        try { await sendMessage(pid, cancelText, env); } catch {}
      }
      // 群内公告
      try { await sendMessage(l.groupId, `❌ **抽奖已结束**\n\n📝 ${esc(l.name)}\n本场未开奖，感谢参与～`, env); } catch {}
      await editMsg(chatId, msgId, `✅ 已结束本次抽奖「${esc(l.name)}」`, env);
      return answerCb(cb.id, '✅ 已结束', env);
    }

    if (action === 'trigger_type') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期，请重新 /create', env);
      const wizard = JSON.parse(raw);
      wizard.data.triggerType = param; // 'time' 或 'count'
      wizard.step = 6;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      if (param === 'time') {
        const timeKb = [
          [{ text: '⏱️ 10分钟后', callback_data: 'wizard_time:10m' }],
          [{ text: '⏱️ 1小时后', callback_data: 'wizard_time:1h' }],
          [{ text: '⏱️ 1天后', callback_data: 'wizard_time:1d' }],
          [{ text: '⏱️ 1周后', callback_data: 'wizard_time:1w' }],
          [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
        ];
        await editMsg(chatId, msgId, `⏰ **定时开奖**\n\n点选快捷时间按钮，或直接输入：\n\`10分钟后\` / \`1小时后\` / \`1天后\` / \`1周后\`\n或具体时间：\`2026-08-25 20:00\``, env, timeKb);
      } else {
        await editMsg(chatId, msgId, `👥 **人数开奖**\n\n请输入参与人数上限（到达后自动开奖，例如：\`50\`）：`, env);
      }
      return answerCb(cb.id, '', env);
    }

    // 快捷时间按钮：10m / 1h / 1d / 1w
    if (action === 'wizard_time') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期，请重新 /create', env);
      const wizard = JSON.parse(raw);
      const unitMap = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
      const num = parseInt(param);
      const unit = param.replace(/^\d+/, '');
      const ms = unitMap[unit];
      if (!ms || isNaN(num)) return answerCb(cb.id, '无效时间', env);
      wizard.data.triggerValue = Date.now() + num * ms;
      const confirmText = `开奖时间：\`${fmtDate(wizard.data.triggerValue)}\``;
      await showWizardGroupPicker(chatId, userId, wizard, confirmText, env);
      return answerCb(cb.id, `✅ ${fmtDate(wizard.data.triggerValue)}`, env);
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
      wizard.step = 9;
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      await editMsg(chatId, msgId, '⏭️ 已跳过，只发布到群', env);
      await showCodeToggle(chatId, userId, wizard, env);
      return answerCb(cb.id, '✅ 跳过', env);
    }

    if (action === 'code_mode') {
      const wizardKey = `wizard:${userId}`;
      const raw = await env.LOTTERY_KV.get(wizardKey);
      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);
      const wizard = JSON.parse(raw);
      if (param === 'yes') {
        wizard.step = 10;
        await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
        const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];
        await editMsg(chatId, msgId, '🎟️ **填写兑换码**（第10步/共10步）\n\n请粘贴**兑换码列表**，**每行一个**：\n\n💡 示例：\n`CODE-7X2K9M`\n`CODE-8PL4QN`\n`CODE-5RW3YT`\n\n📌 支持一行一个，或逗号/空格分隔；开奖时将按中奖名单顺序逐一私信发放。', env, kb);
        return answerCb(cb.id, '📝 请发送兑换码', env);
      }
      // 否：不带兑换码
      wizard.data.useCodes = false;
      wizard.data.codes = [];
      await env.LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      await finishWizard(chatId, msgId, userId, wizard, env);
      return answerCb(cb.id, '✅ 无需兑换码', env);
    }

    if (action === 'cancel_wizard') {
      const wizardKey = `wizard:${userId}`;
      await env.LOTTERY_KV.delete(wizardKey);
      await editMsg(chatId, msgId, '❌ 已取消创建', env);
      return answerCb(cb.id, '已取消', env);
    }

    if (action === 'verify_join') {
      // data 格式: verify_join:<chatId>:<userId>
      const ps = param.split(':');
      const verifyChatId = parseInt(ps[0]);
      const verifyUserId = parseInt(ps[1]);
      if (!verifyChatId || !verifyUserId) return answerCb(cb.id, '无效请求', env);

      // 校验点击者就是待验证用户本人
      if (userId !== verifyUserId) {
        return answerCb(cb.id, '⚠️ 请本人点击验证', env);
      }

      const vKey = `verify_pending:${verifyChatId}:${verifyUserId}`;
      const vRaw = await env.LOTTERY_KV.get(vKey);
      if (!vRaw) {
        return answerCb(cb.id, '⏳ 验证已过期或已完成', env);
      }
      const pending = JSON.parse(vRaw);

      // 解除禁言（若已禁言）
      if (pending.muted) {
        await tgApi(env, 'restrictChatMember', {
          chat_id: verifyChatId,
          user_id: verifyUserId,
          permissions: allPermissionsObject(true),
        }).catch(() => null);
      }

      // 删除待验证记录
      await env.LOTTERY_KV.delete(vKey);
      // 删除验证提示消息
      if (pending.msgId) {
        await tgApi(env, 'deleteMessage', { chat_id: verifyChatId, message_id: pending.msgId }).catch(() => null);
      }

      const name = pending.name || `用户${verifyUserId}`;
      await sendMessage(verifyChatId, `✅ **${esc(name)}** 验证通过，欢迎加入本群！🎉`, env).catch(() => null);
      return answerCb(cb.id, '✅ 验证成功', env);
    }

    if (action === 'announce_publish') {
      const targetGroupId = parseInt(param);
      if (!targetGroupId) return answerCb(cb.id, '无效群ID', env);
      try {
        await publishAnnounce(chatId, userId, targetGroupId, msgId, env);
      } catch (err) {
        console.log('announce publish error:', err);
        await editMsg(chatId, msgId, '❌ 发布失败，请稍后重试', env);
      }
      return answerCb(cb.id, '', env);
    }

    if (action === 'poll_publish') {
      const targetGroupId = parseInt(param);
      if (!targetGroupId) return answerCb(cb.id, '无效群ID', env);
      try {
        await publishPoll(chatId, userId, targetGroupId, msgId, env);
      } catch (err) {
        console.log('poll publish error:', err);
        await editMsg(chatId, msgId, '❌ 发布失败，请稍后重试', env);
      }
      return answerCb(cb.id, '', env);
    }

    if (action === 'cancel_group_pick') {
      await env.LOTTERY_KV.delete(`announce_draft:${userId}`);
      await env.LOTTERY_KV.delete(`poll_draft:${userId}`);
      await editMsg(chatId, msgId, '❌ 已取消发布', env);
      return answerCb(cb.id, '已取消', env);
    }

    if (action === 'cancel_announce_pending' || action === 'cancel_poll_pending') {
      await env.LOTTERY_KV.delete(`announce_pending:${userId}`);
      await env.LOTTERY_KV.delete(`poll_pending:${userId}`);
      await editMsg(chatId, msgId, '❌ 已取消', env);
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
    prizes: Array.isArray(wizard.data.prizes) && wizard.data.prizes.length ? wizard.data.prizes : [wizard.data.prize || ''],
    winnerCount: wizard.data.winnerCount || 1,
    keyword: wizard.data.keyword,
    triggerType: wizard.data.triggerType,
    triggerValue: wizard.data.triggerValue,
    channel: wizard.data.channel || '',
    useCodes: !!wizard.data.useCodes,
    codes: Array.isArray(wizard.data.codes) ? wizard.data.codes : [],
    codesUsed: [],
    participants: [],
    participantNames: {},
    winners: [],
    status: 'active',
    createdAt: now,
    drawnAt: null,
    groupMsgId: null,   // 群公告消息ID（置顶/取消置顶用）
    channelMsgId: null, // 频道公告消息ID
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

  const codeText = lottery.useCodes
    ? `\n🎟️ 中奖后由 bot 私信发放兑换码`
    : '';

  // 发布到群
  const groupPost = `🎊 **抽奖开始啦！** 🎊

━━━━━━━━━━━━━━━━
📝 **活动名称：** ${esc(lottery.name)}
🎁 **奖品：** ${esc(lottery.prize)}
🏆 **中奖名额：** ${lottery.winnerCount} 人
${triggerText}${channelText}${codeText}
━━━━━━━━━━━━━━━━

🔑 在群内发送口令 \`${lottery.keyword}\` 即可参与抽奖！`;

  let groupMsgId = null;
  if (botInGroup) {
    const postRes = await sendMessage(lottery.groupId, groupPost, env);
    if (postRes && postRes.ok && postRes.result?.message_id) {
      groupMsgId = postRes.result.message_id;
      lottery.groupMsgId = groupMsgId; // 记录公告消息ID（开奖/取消时取消置顶）
    }
  }

  // 发布到频道（如有）
  let channelMsgId = null;
  if (lottery.channel) {
    try {
      const chRes = await sendMessage(lottery.channel, groupPost, env);
      if (chRes && chRes.ok && chRes.result?.message_id) {
        channelMsgId = chRes.result.message_id;
        lottery.channelMsgId = channelMsgId;
      }
    } catch {}
  }

  // 自动置顶：群公告置顶（需要 bot 有 pin 权限，失败静默）
  if (lottery.groupId && groupMsgId) {
    try {
      await tgApi(env, 'pinChatMessage', {
        chat_id: lottery.groupId,
        message_id: groupMsgId,
        disable_notification: false,
      });
    } catch {}
  }
  // 同步存储（含置顶信息）
  await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));

  // 私聊给创建者确认
  const botWarn = botInGroup
    ? ''
    : `\n⚠️ **机器人不在发布群中**，公告未能发布！\n请把机器人加入该群（设为管理员）后，手动发送公告或在私聊中使用 /groups 检查。`;

  const confirmText = `✅ **创建成功！**

🆔 **ID：** \`${lottery.id}\`
📢 **发布群：** \`${lottery.groupId}\`${lottery.groupName ? `（${esc(lottery.groupName)}）` : ''}
${lottery.channel ? `📢 **频道：** ${lottery.channel}` : ''}
🔑 **口令：** \`${lottery.keyword}\`
${lottery.useCodes ? `🎟️ **兑换码：** ${lottery.codes.length} 个（开奖时自动私信中奖者）` : ''}
${botWarn}`;

  const doneKb = [
    [{ text: '📋 我的抽奖', callback_data: 'menu:list' },
     { text: '🎲 立即开奖', callback_data: `lot_draw:${lottery.id}` }],
    [{ text: '🏠 主菜单', callback_data: 'menu_back' }],
  ];

  if (msgId) {
    await editMsg(chatId, msgId, confirmText, env, doneKb);
  } else {
    await sendMsgKb(chatId, confirmText, doneKb, env);
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

    // 参与成功时提示开启私信提醒 + 兑奖（点按钮 t.me/bot?start=notify / start=redeem）
      const nbt = await notifyButton(env);
      if (nbt) {
        await sendMsgKb(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯\n\n🔔 点击「开启中奖私信提醒」：开奖结果私信送达\n🎟️ 点击「兑奖」：中奖后直接领取兑奖码`, nbt, env);
      } else {
        await sendMessage(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯`, env);
      }

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

  // 开奖后取消原公告置顶（若仍有置顶）
  if (lottery.groupMsgId) {
    try {
      await tgApi(env, 'unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId });
    } catch {}
  }

  const winnerNames = winners.map(id => lottery.participantNames[id] || `用户${id}`);
  const prizes = (lottery.prizes && lottery.prizes.length) ? lottery.prizes : [lottery.prize || '奖品'];

  // 群内公告：多奖品时按中奖顺序展示对应奖品
  const winnerList = winnerNames.map((n, i) => {
    const p = prizes[Math.min(i, prizes.length - 1)];
    const prizePart = prizes.length > 1 ? ` → ${esc(p)}` : '';
    return `${i + 1}. @${esc(n)}${prizePart}`;
  }).join('\n');
  const groupText = `🎊🎊🎊 **开奖啦！** 🎊🎊🎊

━━━━━━━━━━━━━━━━━━
📝 **活动：** ${esc(lottery.name)}
${prizes.length > 1 ? `🎁 **奖品：**\n${prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n')}` : `🎁 **奖品：** ${esc(lottery.prize)}`}
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

  // 私信通知中奖者（检测失败，不静默）
  const dmFailed = [];
  let codeIdx = 0;
  const codeAssignments = {}; // winnerId -> code
  for (let wi = 0; wi < winners.length; wi++) {
    const winnerId = winners[wi];
    const name = lottery.participantNames[winnerId] || `用户${winnerId}`;
    const myPrize = prizes[Math.min(wi, prizes.length - 1)];
    let codeText = '';
    if (lottery.useCodes && Array.isArray(lottery.codes)) {
      if (codeIdx < lottery.codes.length) {
        const code = lottery.codes[codeIdx];
        codeIdx++;
        codeAssignments[winnerId] = code;
        codeText = `\n🎟️ **兑奖码：** \`${esc(code)}\``;
        lottery.codesUsed.push(code);
      } else {
        codeText = '\n⚠️ 兑奖码已发放完毕，请联系管理员单独处理';
      }
    }
    const dmText = `🥳🥳 **恭喜中奖啦！** 🥳🥳

━━━━━━━━━━━━━━━━
**抽奖群：** ${esc(chatTitle || lottery.groupName)}
**活动名称：** ${esc(lottery.name)}
**获得奖品：** ${esc(myPrize)}${codeText}
━━━━━━━━━━━━━━━━

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
    const res = await sendMsgKb(winnerId, dmText, [
      [{ text: '🎟️ 立即兑奖', callback_data: `redeem:${lotteryId}` }],
    ], env);
    if (!res || !res.ok) {
      dmFailed.push(winnerId);
    }
  }

  // 持久化已使用兑换码 + 登记中奖者兑奖记录（无码也登记，方便「兑奖」页展示）
  if (lottery.useCodes && codeIdx > 0) {
    await env.LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  }
  for (let wi = 0; wi < winners.length; wi++) {
    const winnerId = winners[wi];
    const myPrize = prizes[Math.min(wi, prizes.length - 1)];
    const myCode = codeAssignments[winnerId] || null;
    const redeemKey = `my_redeem:${winnerId}`;
    const rawR = await env.LOTTERY_KV.get(redeemKey);
    let list = rawR ? JSON.parse(rawR) : [];
    list = list.filter(x => x.lotteryId !== lotteryId);
    list.unshift({ lotteryId, name: lottery.name, prize: myPrize, code: myCode, groupName: lottery.groupName || (chatTitle || ''), drawnAt: lottery.drawnAt || Date.now() });
    list = list.slice(0, 30);
    await env.LOTTERY_KV.put(redeemKey, JSON.stringify(list));
  }

  // 私信失败的：在群里补一条提示（中奖者需先私聊机器人才能收到通知）
  if (dmFailed.length > 0) {
    const failedNames = dmFailed.map(id => lottery.participantNames[id] || `用户${id}`);
    const tip = `💡 中奖通知私信失败：${failedNames.map(esc).join('、')}\n\n请**私聊机器人**发送任意消息（或点击上一篇参与成功消息里的「🔔 开启中奖私信提醒」按钮），以便接收中奖通知。`;
    try { await sendMessage(lottery.groupId, tip, env); } catch {}
    console.log('DM failed for:', dmFailed.join(','));
  }

  // 通知创建者
  const winnerIds = winners;
  const creatorList = winnerNames.map((n, i) => {
    const code = codeAssignments[winnerIds[i]];
    const myPrize = prizes[Math.min(i, prizes.length - 1)];
    return `${i + 1}- ${n}  获得:${esc(myPrize)}${code ? `\n    🎟️ 兑换码: \`${esc(code)}\`` : ''}`;
  }).join('\n');
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
  // 取消时也取消置顶
  if (lottery.groupMsgId) {
    try {
      await tgApi(env, 'unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId });
    } catch {}
  }
  return sendMessage(chatId, `✅ 抽奖 \`${lotteryId}\` 已取消`, env);
}

async function listLotteries(chatId, env, chatTitle, userId, msgId) {
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
        if (l.status === 'active' && l.creatorId === userId) active.push(l);
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
  if (active.length === 0) {
    const msg = '📭 当前没有进行中的抽奖\n\n💡 私聊机器人发送 /create 创建一个吧～';
    if (msgId) return editMsg(chatId, msgId, msg, env);
    return sendMessage(chatId, msg, env);
  }

  const kb = active.map((l) => {
    const trigger = l.triggerType === 'time' ? `⏰ ${fmtDate(l.triggerValue)}` : `👥 ${l.participants.length}/${l.triggerValue}人`;
    return [{ text: `🎯 ${esc(l.name)}（👥${l.participants.length}・${trigger}）`, callback_data: `lot_view:${l.id}` }];
  });
  kb.push([{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📢 发布公告', callback_data: 'menu:announce' }]);
  kb.push([{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '🔙 返回菜单', callback_data: 'menu_back' }]);

  const text = `📋 **进行中的抽奖（${active.length}）：**\n\n点击查看详情，可立即开奖 / 结束本次抽奖：`;
  if (msgId) return editMsg(chatId, msgId, text, env, kb);
  return sendMsgKb(chatId, text, kb, env);
}

// 抽奖详情（来自内联键盘）
async function showLotteryDetail(chatId, userId, msgId, lotteryId, env) {
  const raw = await env.LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return editMsg(chatId, msgId, '❌ 抽奖不存在（可能已删除）', env);
  const l = JSON.parse(raw);
  const isCreator = l.creatorId === userId;
  const trigger = l.triggerType === 'time' ? `⏰ ${fmtDate(l.triggerValue)}` : `👥 ${l.participants.length}/${l.triggerValue}人`;
  const prizes = (l.prizes && l.prizes.length) ? l.prizes : [l.prize || ''];
  const text = `🎯 **抽奖详情**（${l.status === 'active' ? '⏳ 进行中' : l.status === 'completed' ? '✅ 已开奖' : '❌ 已取消'}）

📝 **名称：** ${esc(l.name)}
🎁 **奖品：**\n${prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n')}
👥 **参与人数：** ${l.participants ? l.participants.length : 0}
${trigger}
🔑 **口令：** \`${esc(l.keyword)}\`
🆔 **ID：** \`${l.id}\``;

  const kb = [];
  if (isCreator && l.status === 'active') {
    if (l.participants && l.participants.length > 0) {
      kb.push([{ text: '🎲 立即开奖', callback_data: `lot_draw:${l.id}` }]);
    }
    kb.push([{ text: '❌ 结束本次抽奖', callback_data: `lot_end:${l.id}` }]);
  }
  kb.push([{ text: '🔙 返回列表', callback_data: 'menu:list' }, { text: '🏠 主菜单', callback_data: 'menu_back' }]);
  return editMsg(chatId, msgId, text, env, kb);
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

// 时区配置：KV 存 offset 小时（默认 +8 北京时间）
// bot_timezone 为整数小时偏移，如 8 / 9 / 0
let TZ_OFFSET_HOURS = 8;

async function loadTzOffset(env) {
  try {
    const raw = await env.LOTTERY_KV.get('bot_timezone');
    if (!raw) { TZ_OFFSET_HOURS = 8; return; }
    const parsed = parseInt(raw);
    TZ_OFFSET_HOURS = isNaN(parsed) ? 8 : parsed;
  } catch {
    TZ_OFFSET_HOURS = 8;
  }
}

// 显示为当前时区时间：Workers 默认 UTC，按 TZ_OFFSET_HOURS 偏移后取 UTC 字段
function fmtDate(ts) {
  const d = new Date((ts || 0) + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 把「当前时区」的年月日时分 转成 UTC 时间戳（输入按当前时区解析）
function parseLocalTime(y, m, d, h, min) {
  return Date.UTC(+y, +m - 1, +d, +h - TZ_OFFSET_HOURS, +min, 0);
}

// 解析相对时间：10分钟后 / 1小时后 / 1天后 / 1周后（也支持不带“后”）
function parseRelativeTime(text) {
  const t = (text || '').trim();
  const m = t.match(/^(\d{1,4})\s*(分钟|小时|天|周|星期|min|h|d|w|m)\s*(后)?$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  const now = Date.now();
  if (unit === '分钟' || unit === 'min' || unit === 'm') return now + n * 60 * 1000;
  if (unit === '小时' || unit === 'h') return now + n * 60 * 60 * 1000;
  if (unit === '天' || unit === 'd') return now + n * 24 * 60 * 60 * 1000;
  if (unit === '周' || unit === '星期' || unit === 'w') return now + n * 7 * 24 * 60 * 60 * 1000;
  return null;
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

// 获取 bot 用户名（调用 getMe 并缓存到 KV，避免每次请求）
async function getBotUsername(env) {
  try {
    const cached = await env.LOTTERY_KV.get('bot_username');
    if (cached) return cached;
    const res = await tgApi(env, 'getMe', {});
    if (res.ok && res.result?.username) {
      const uname = res.result.username;
      await env.LOTTERY_KV.put('bot_username', uname);
      return uname;
    }
  } catch {}
  return '';
}

// 构造「开启私信提醒 + 兑奖」按钮（t.me/bot?start=notify / start=redeem）
async function notifyButton(env) {
  const uname = await getBotUsername(env);
  if (!uname) return null;
  return [
    [{ text: '🔔 开启中奖私信提醒', url: `https://t.me/${uname}?start=notify` }],
    [{ text: '🎟️ 兑奖', url: `https://t.me/${uname}?start=redeem` }],
  ];
}

// ==================== 兑奖 ====================

// 用户通过 t.me/bot?start=redeem 进入：查询其待兑奖记录并展示
async function handleRedeemStart(chatId, userId, env) {
  const redeemKey = `my_redeem:${userId}`;
  const rawR = await env.LOTTERY_KV.get(redeemKey);
  let list = [];
  if (rawR) {
    try { list = JSON.parse(rawR); } catch {}
  }
  if (!list || list.length === 0) {
    return sendMessage(chatId, '🎟️ 你目前**没有待兑奖的奖品**。\n\n💡 参与抽奖并中奖后，bot 会私信通知你，点击通知里的「立即兑奖」即可完成兑奖～', env);
  }
  const lines = list.map((x, i) => `${i + 1}. **${esc(x.name)}**\n   🎁 ${esc(x.prize)}${x.code ? ` · 🎟️ \`${esc(x.code)}\`` : ''}\n   📅 ${fmtDate(x.drawnAt)}\n   · ${esc(x.groupName || '')}`).join('\n\n');
  const kb = [[{ text: '✅ 全部标记已领取', callback_data: 'redeem_clear' }]];
  return sendMsgKb(chatId, `🎟️ **你的中奖记录**：\n\n${lines}\n\n📌 兑奖码已在上方展示；点击「全部标记已领取」可清空本列表。`, kb, env);
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
