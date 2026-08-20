/**
 * 群组管家 v5.0 - Cloudflare Workers
 * 抽奖模块（私聊创建+发布置顶+口令参与+定时/人数开奖+私信通知）
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
    const flag = await env.LOTTERY_KV.get('commands_set_v6');
    if (flag === '1') return;

    const token = env.BOT_TOKEN || '';
    const url = `${TELEGRAM_API}/bot${token}/setMyCommands`;
    const privateCommands = [
      { command: 'create', description: '✨ 创建抽奖（8步向导）' },
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

    await env.LOTTERY_KV.put('commands_set_v5', '1');
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
      if (deepLink === 'notify' || deepLink === '开启提醒') {
        return sendMessage(chatId, '🔔 **中奖私信提醒已开启！**\n\n以后你参与的抽奖开奖后，中奖结果会第一时间私信通知你～\n（本提示仅需开启一次，之后所有抽奖自动生效）', env);
      }
      return sendMessage(chatId, '🎉 **群组管家 v6.1**\n\n📌 所有功能都在**私聊**向我发起，发布到你选择的群：\n\n✨ `/create` 创建抽奖（向导）\n📢 `/announce` 发布群公告（自动置顶）\n📊 `/poll` 发起群投票\n\n📋 `/list` 我创建的抽奖\n🎲 `/draw ID` 手动开奖 · ❌ `/cancel ID` 取消\n🤖 `/groups` 查看我已加入的群\n\n💡 输入 `/announce` 或 `/poll` 后，按提示发送内容即可', env);
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
    return;
  }

  // ---- 私聊：向导步骤 / 投票 / 公告 草稿 / 待输入内容 ----
  if (chatType === 'private') {
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
  if (!cfg.enabled) return;

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
  };
  await env.LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });

  // 发送验证提示消息
  const text = `👋 欢迎 **${esc(name)}** 加入本群！\n\n🛡️ 为防广告/骚扰，请点击下方按钮完成**入群验证**，10分钟内未验证将被移出群聊。`;
  const kb = [[{ text: '✅ 点我通过验证', callback_data: `verify_join:${chat.id}:${userId}` }]];
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
  const kb = [];
  for (const g of groups.slice(0, 12)) {
    kb.push([{ text: `📢 ${esc(g.title || g.id)}`, callback_data: `${actionPrefix}:${g.id}` }]);
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
  const groupKb = [];
  for (const g of groups.slice(0, 12)) {
    groupKb.push([{ text: `📢 ${esc(g.title || g.id)}`, callback_data: `select_group:${g.id}` }]);
  }
  groupKb.push([{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]);
  return sendMsgKb(chatId, `✅ ${confirmText}\n\n📢 第7步：请选择**公告发布群**（公告发到该群，参与也在此群）：`, groupKb, env);
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
        let targetTime = parseRelativeTime(text);
        if (targetTime === null) {
          const timeMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
          if (!timeMatch) {
            return sendMsgKb(chatId, '❌ 时间格式错误，请输入：\n`10分钟后` / `1小时后` / `1天后` / `1周后`\n或具体时间：`2026-08-25 20:00`', kb, env);
          }
          const [, y, m, d, h, min] = timeMatch;
          targetTime = parseBeijingTime(y, m, d, h, min);
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

  // 发布到群
  const groupPost = `🎊 **抽奖开始啦！** 🎊

━━━━━━━━━━━━━━━━
📝 **活动名称：** ${esc(lottery.name)}
🎁 **奖品：** ${esc(lottery.prize)}
🏆 **中奖名额：** ${lottery.winnerCount} 人
${triggerText}${channelText}
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

    // 参与成功时提示开启私信提醒（点按钮 t.me/bot?start=notify 后 bot 才能给用户私信）
      const nbt = await notifyButton(env);
      if (nbt) {
        await sendMsgKb(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯\n\n🔔 点击下方按钮开启中奖私信提醒（开奖结果私信送达）：`, nbt, env);
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

  // 私信通知中奖者（检测失败，不静默）
  const dmFailed = [];
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
    const res = await sendMessage(winnerId, dmText, env);
    if (!res || !res.ok) {
      dmFailed.push(winnerId);
    }
  }

  // 私信失败的：在群里补一条提示（中奖者需先私聊机器人才能收到通知）
  if (dmFailed.length > 0) {
    const failedNames = dmFailed.map(id => lottery.participantNames[id] || `用户${id}`);
    const tip = `💡 中奖通知私信失败：${failedNames.map(esc).join('、')}\n\n请**私聊机器人**发送任意消息（或点击上一篇参与成功消息里的「🔔 开启中奖私信提醒」按钮），以便接收中奖通知。`;
    try { await sendMessage(lottery.groupId, tip, env); } catch {}
    console.log('DM failed for:', dmFailed.join(','));
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
  // 取消时也取消置顶
  if (lottery.groupMsgId) {
    try {
      await tgApi(env, 'unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId });
    } catch {}
  }
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

// 显示为北京时间（UTC+8）：Workers 默认 UTC，直接加 8 小时再取 UTC 字段
function fmtDate(ts) {
  const d = new Date((ts || 0) + 8 * 60 * 60 * 1000);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 把「北京时间」的年月日时分 转成 UTC 时间戳（输入按中国时区解析）
function parseBeijingTime(y, m, d, h, min) {
  return Date.UTC(+y, +m - 1, +d, +h - 8, +min, 0);
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

// 构造「开启私信提醒」按钮（t.me/bot?start=notify）
async function notifyButton(env) {
  const uname = await getBotUsername(env);
  if (!uname) return null;
  return [[{ text: '🔔 开启中奖私信提醒', url: `https://t.me/${uname}?start=notify` }]];
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
