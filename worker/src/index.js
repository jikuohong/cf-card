/**
 * 信用卡账单管理 - Cloudflare Worker
 * 功能：邮件自动解析 / REST API / 每日 TG 推送
 */

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  });
}

function corsRes() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── KV 操作 ───────────────────────────────────────────────────────────────

async function getCards(env) {
  const raw = await env.CREDIT_CARD_KV.get('cards');
  return raw ? JSON.parse(raw) : [];
}

async function saveCards(env, cards) {
  await env.CREDIT_CARD_KV.put('cards', JSON.stringify(cards));
}

// ─── AI 解析邮件 ───────────────────────────────────────────────────────────

async function parseEmailWithAI(emailText, env) {
  const prompt = `你是信用卡账单解析专家。从以下邮件中提取信用卡账单信息，以 JSON 格式返回，不要有任何多余文字或 markdown：

{
  "bankName": "银行名称（如工商银行、建设银行）",
  "cardLast4": "卡号后4位数字字符串",
  "billingDate": "账单日，格式 MM-DD",
  "paymentDueDate": "还款截止日，格式 MM-DD",
  "statementAmount": 本期账单金额（纯数字），
  "minPayment": 最低还款额（纯数字），
  "creditLimit": 信用额度（纯数字），
  "usedAmount": 已用额度（纯数字），
  "availableAmount": 可用额度（纯数字），
  "unbilledAmount": 未出账单消费（纯数字）
}

找不到的字段填 null。只返回 JSON。

邮件内容：
${emailText.slice(0, 3000)}`;

  try {
    // 优先使用 Cloudflare AI
    if (env.AI) {
      const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      });
      const text = response.response || '';
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    }

    // 降级：正则兜底解析
    return regexParse(emailText);
  } catch {
    return regexParse(emailText);
  }
}

// 正则兜底解析
function regexParse(text) {
  const num = (pattern) => {
    const m = text.match(pattern);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };
  const str = (pattern) => {
    const m = text.match(pattern);
    return m ? m[1].trim() : null;
  };

  const banks = ['工商银行','建设银行','招商银行','浦发银行','中国银行','农业银行','交通银行','民生银行','光大银行','广发银行','平安银行','兴业银行','华夏银行','北京银行'];
  const bankName = banks.find(b => text.includes(b)) || null;

  return {
    bankName,
    cardLast4: str(/[（(]尾号\s*(\d{4})[）)]/),
    billingDate: str(/账单日[：:]\s*\d{4}年(\d{1,2}月\d{1,2}日)/)?.replace('月','-').replace('日','') || null,
    paymentDueDate: str(/(?:还款截止日|最后还款日|到期还款日)[：:]\s*\d{4}年(\d{1,2}月\d{1,2}日)/)?.replace('月','-').replace('日','') || null,
    statementAmount: num(/(?:本期账单金额|本期应还金额|应还金额)[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    minPayment: num(/最低还款额?[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    creditLimit: num(/(?:信用额度|授信额度)[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    usedAmount: num(/(?:已用额度|本期消费)[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    availableAmount: num(/可用额度[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    unbilledAmount: num(/(?:未出账单消费|未出账消费|未入账消费)[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
  };
}

// ─── 邮件处理 ──────────────────────────────────────────────────────────────

async function handleEmailEvent(message, env) {
  const from = message.from || '';
  const subject = message.headers?.get?.('subject') || '';

  // 读取原始邮件内容
  let rawEmail = `From: ${from}\nSubject: ${subject}\n\n`;
  try {
    const reader = message.raw.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    rawEmail += chunks.join('');
  } catch (e) {
    console.error('Read email error:', e);
  }

  // 过滤：只处理看起来像账单的邮件
  const billKeywords = ['账单','还款','信用卡','Credit','Statement','Bill'];
  const isBill = billKeywords.some(k => rawEmail.includes(k) || subject.includes(k));
  if (!isBill) return;

  // AI 解析
  const parsed = await parseEmailWithAI(rawEmail, env);
  if (!parsed || !parsed.bankName) return;

  // 存入 KV
  const cards = await getCards(env);
  const existing = cards.findIndex(
    c => c.cardLast4 === parsed.cardLast4 && c.bankName === parsed.bankName
  );
  const card = {
    id: existing >= 0 ? cards[existing].id : genId(),
    ...parsed,
    emailFrom: from,
    updatedAt: new Date().toISOString(),
    source: 'email',
  };

  if (existing >= 0) {
    cards[existing] = card;
  } else {
    cards.push(card);
  }
  await saveCards(env, cards);

  // 即时 TG 通知
  const msg = `📬 *收到新账单*\n\n` +
    `🏦 ${card.bankName}（${card.cardLast4 ? '····' + card.cardLast4 : ''}）\n` +
    `📅 还款截止：${card.paymentDueDate || '未知'}\n` +
    `💰 本期账单：¥${card.statementAmount?.toLocaleString() || '—'}\n` +
    `💳 可用额度：¥${card.availableAmount?.toLocaleString() || '—'}`;
  await sendTelegram(msg, env);
}

// ─── TG 推送 ───────────────────────────────────────────────────────────────

async function sendTelegram(text, env) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

// 计算距今天数（今天=0，负数=已逾期）
function daysUntil(mmdd) {
  if (!mmdd) return null;
  const now = new Date();
  const [mm, dd] = mmdd.split('-').map(Number);
  let due = new Date(now.getFullYear(), mm - 1, dd);
  // 如果这个月的日期已过，算下个月
  if (due < now && now.getDate() > dd) due.setMonth(due.getMonth() + 1);
  return Math.ceil((due - now) / 86400000);
}

async function sendDailyReminders(env) {
  const cards = await getCards(env);
  if (!cards.length) return;

  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let lines = [`📊 *信用卡还款日报* — ${today}\n`];

  const urgent = [], normal = [], overdue = [];

  for (const c of cards) {
    const days = daysUntil(c.paymentDueDate);
    const name = `${c.bankName || ''}${c.cardLast4 ? '····' + c.cardLast4 : ''}`;
    const amount = c.statementAmount ? `¥${c.statementAmount.toLocaleString()}` : '—';
    const dueStr = c.paymentDueDate || '—';

    if (days === null) {
      normal.push({ name, amount, dueStr, days });
    } else if (days < 0) {
      overdue.push({ name, amount, dueStr, days });
    } else if (days <= 3) {
      urgent.push({ name, amount, dueStr, days });
    } else {
      normal.push({ name, amount, dueStr, days });
    }
  }

  if (overdue.length) {
    lines.push('🔴 *已逾期*');
    overdue.forEach(c => lines.push(`  • ${c.name}｜${c.amount}｜还款日 ${c.dueStr}（逾期 ${Math.abs(c.days)} 天）`));
    lines.push('');
  }

  if (urgent.length) {
    lines.push('🟠 *紧急提醒（3天内到期）*');
    urgent.forEach(c => lines.push(`  • ${c.name}｜${c.amount}｜还剩 ${c.days} 天`));
    lines.push('');
  }

  if (normal.length) {
    lines.push('🟢 *正常账单*');
    normal.forEach(c => {
      const dayStr = c.days !== null ? `还剩 ${c.days} 天` : '日期未知';
      lines.push(`  • ${c.name}｜${c.amount}｜${dayStr}`);
    });
    lines.push('');
  }

  const totalDue = cards.reduce((s, c) => s + (c.statementAmount || 0), 0);
  const totalAvail = cards.reduce((s, c) => s + (c.availableAmount || 0), 0);
  lines.push(`💰 本期合计应还：*¥${totalDue.toLocaleString()}*`);
  lines.push(`💳 可用额度合计：¥${totalAvail.toLocaleString()}`);

  await sendTelegram(lines.join('\n'), env);
}

// ─── 鉴权 ─────────────────────────────────────────────────────────────────

async function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { ok: false };

  const token = auth.slice(7);
  // 验证 token 是否在 KV 中有效
  const stored = await env.CREDIT_CARD_KV.get(`session:${token}`);
  return { ok: !!stored };
}

async function handleLogin(request, env) {
  const { password } = await request.json().catch(() => ({}));
  if (!password || password !== env.ADMIN_PASSWORD) {
    return jsonRes({ error: '密码错误' }, 401);
  }
  const token = genId() + genId();
  // session 有效期 7 天
  await env.CREDIT_CARD_KV.put(`session:${token}`, '1', { expirationTtl: 604800 });
  return jsonRes({ token });
}

// ─── API 路由处理 ──────────────────────────────────────────────────────────

async function apiGetCards(env) {
  const cards = await getCards(env);
  return jsonRes(cards);
}

async function apiAddCard(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonRes({ error: '无效数据' }, 400);

  const cards = await getCards(env);
  const card = { id: genId(), ...body, updatedAt: new Date().toISOString(), source: 'manual' };
  cards.push(card);
  await saveCards(env, cards);
  return jsonRes(card);
}

async function apiUpdateCard(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonRes({ error: '无效数据' }, 400);

  const cards = await getCards(env);
  const idx = cards.findIndex(c => c.id === id);
  if (idx < 0) return jsonRes({ error: '卡片不存在' }, 404);

  cards[idx] = { ...cards[idx], ...body, id, updatedAt: new Date().toISOString() };
  await saveCards(env, cards);
  return jsonRes(cards[idx]);
}

async function apiDeleteCard(env, id) {
  const cards = await getCards(env);
  const filtered = cards.filter(c => c.id !== id);
  if (filtered.length === cards.length) return jsonRes({ error: '卡片不存在' }, 404);
  await saveCards(env, filtered);
  return jsonRes({ ok: true });
}

async function apiParseEmail(request, env) {
  const { emailText } = await request.json().catch(() => ({}));
  if (!emailText) return jsonRes({ error: '请提供邮件内容' }, 400);

  const parsed = await parseEmailWithAI(emailText, env);
  if (!parsed || !parsed.bankName) return jsonRes({ error: '无法识别账单信息' }, 422);

  const cards = await getCards(env);
  const existing = cards.findIndex(
    c => c.cardLast4 === parsed.cardLast4 && c.bankName === parsed.bankName
  );
  const card = {
    id: existing >= 0 ? cards[existing].id : genId(),
    ...parsed,
    updatedAt: new Date().toISOString(),
    source: 'manual',
  };

  if (existing >= 0) { cards[existing] = card; } else { cards.push(card); }
  await saveCards(env, cards);
  return jsonRes(card);
}

async function apiTriggerPush(env) {
  await sendDailyReminders(env);
  return jsonRes({ ok: true, message: 'TG 推送已发送' });
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

export default {
  // 邮件接收处理
  async email(message, env, ctx) {
    ctx.waitUntil(handleEmailEvent(message, env));
  },

  // HTTP 请求处理
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsRes();

    const url = new URL(request.url);
    const path = url.pathname;

    // 登录
    if (path === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // 其他接口需要鉴权
    const auth = await checkAuth(request, env);
    if (!auth.ok) return jsonRes({ error: '未授权，请先登录' }, 401);

    if (path === '/api/cards') {
      if (request.method === 'GET')  return apiGetCards(env);
      if (request.method === 'POST') return apiAddCard(request, env);
    }

    const cardMatch = path.match(/^\/api\/cards\/(.+)$/);
    if (cardMatch) {
      const id = cardMatch[1];
      if (request.method === 'PUT')    return apiUpdateCard(request, env, id);
      if (request.method === 'DELETE') return apiDeleteCard(env, id);
    }

    if (path === '/api/parse' && request.method === 'POST') {
      return apiParseEmail(request, env);
    }

    if (path === '/api/push' && request.method === 'POST') {
      return apiTriggerPush(env);
    }

    return jsonRes({ error: 'Not Found' }, 404);
  },

  // Cron 定时触发
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  },
};
