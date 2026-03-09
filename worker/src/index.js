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

// ─── 邮件内容清洗 ──────────────────────────────────────────────────────────

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64Body(str) {
  try {
    const clean = str.replace(/\s+/g, '');
    const decoded = atob(clean);
    const bytes = new Uint8Array([...decoded].map(c => c.charCodeAt(0)));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return str;
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|td|th|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEmailText(raw) {
  let text = raw;

  // 1. 解码 quoted-printable
  if (/=[0-9A-Fa-f]{2}/.test(text)) {
    text = decodeQuotedPrintable(text);
  }

  // 2. 处理 MIME multipart
  const boundaryMatch = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sections = text.split(new RegExp('--' + escaped, 'g'));
    const parts = [];
    for (const section of sections) {
      const isHtml  = /content-type:\s*text\/html/i.test(section);
      const isPlain = /content-type:\s*text\/plain/i.test(section);
      const isB64   = /content-transfer-encoding:\s*base64/i.test(section);
      const isQP    = /content-transfer-encoding:\s*quoted-printable/i.test(section);
      const bodyMatch = section.match(/\r?\n\r?\n([\s\S]+)/);
      if (!bodyMatch) continue;
      let body = bodyMatch[1].trim();
      if (isB64) body = decodeBase64Body(body);
      if (isQP)  body = decodeQuotedPrintable(body);
      if (isHtml) body = stripHtml(body);
      if (isHtml || isPlain) parts.push(body);
    }
    if (parts.length) return parts.join('\n\n');
  }

  // 3. 非 multipart
  const headerEnd = text.indexOf('\n\n');
  if (headerEnd > 0) {
    const headers = text.slice(0, headerEnd);
    let   body    = text.slice(headerEnd + 2);
    const isB64   = /content-transfer-encoding:\s*base64/i.test(headers);
    const isQP    = /content-transfer-encoding:\s*quoted-printable/i.test(headers);
    const isHtml  = /content-type:\s*text\/html/i.test(headers);
    if (isB64)  body = decodeBase64Body(body);
    if (isQP)   body = decodeQuotedPrintable(body);
    if (isHtml) body = stripHtml(body);
    return headers + '\n\n' + body;
  }

  // 4. 兜底剥 HTML
  if (/<html|<body|<div/i.test(text)) return stripHtml(text);
  return text;
}

// ─── AI 解析邮件 ───────────────────────────────────────────────────────────

async function parseEmailWithAI(rawEmailText, env) {
  const emailText = extractEmailText(rawEmailText);

  const prompt = `你是信用卡账单解析专家。从以下邮件中提取信用卡账单信息，以 JSON 格式返回，不要有任何多余文字或 markdown：

{
  "bankName": "银行名称（如工商银行、建设银行）",
  "cardLast4": "卡号后4位数字字符串",
  "billingDate": "账单日，格式 MM-DD",
  "paymentDueDate": "还款截止日，格式 MM-DD",
  "statementAmount": 本期账单金额数字,
  "minPayment": 最低还款额数字,
  "creditLimit": 信用额度数字,
  "usedAmount": 已用额度数字,
  "availableAmount": 可用额度数字,
  "unbilledAmount": 未出账单消费数字
}

找不到的字段填 null。只返回 JSON。

邮件内容：
${emailText.slice(0, 4000)}`;

  try {
    if (env.AI) {
      const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      });
      const aiText = response.response || '';
      const parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim());
      // AI 没提取到金额字段时用正则补充
      if (!parsed.statementAmount && !parsed.availableAmount) {
        const regex = regexParse(emailText);
        return { ...regex, ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null)) };
      }
      return parsed;
    }
    return regexParse(emailText);
  } catch {
    return regexParse(emailText);
  }
}

// 正则兜底解析
function regexParse(text) {
  const num = (patterns) => {
    for (const p of (Array.isArray(patterns) ? patterns : [patterns])) {
      const m = text.match(p);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }
    return null;
  };
  const str = (patterns) => {
    for (const p of (Array.isArray(patterns) ? patterns : [patterns])) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return null;
  };

  const banks = ['工商银行','建设银行','招商银行','浦发银行','中国银行','农业银行','交通银行','民生银行','光大银行','广发银行','平安银行','兴业银行','华夏银行','北京银行','中信银行'];
  const bankName = banks.find(b => text.includes(b)) || null;

  // 卡号后四位 - 支持表格形式 "1071(牡丹贷记卡)" 和 "(尾号1234)"
  const cardLast4 = (() => {
    const patterns = [
      /[（(](?:尾号|末四位)[：:\s]*(\d{4})[）)]/,
      /卡号后四位[\s\S]{0,20}?(\d{4})/,
      /^(\d{4})[（(]/m,
      /---主卡明细---[\s\S]{0,50}?^(\d{4})\b/m,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1];
    }
    return null;
  })();

  // 账单日 - 支持"对账单生成日"、"账单日"、"账单周期结束日"
  const billingDate = (() => {
    const patterns = [
      /(?:对账单生成日|账单日|账单生成日)[：:\s]*(\d{4})年(\d{1,2})月(\d{1,2})日/,
      /账单日[：:]\s*\d{4}年(\d{1,2})月(\d{1,2})日/,
      /账单日[：:]\s*(\d{1,2})[月/-](\d{1,2})/,
      // 账单周期末尾日期: "2026年02月01日—2026年02月28日" 取后面的日期
      /账单周期[\s\S]{0,30}?—(\d{4})年(\d{1,2})月(\d{1,2})日/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        // 有年份的格式 (3个捕获组)
        if (m.length >= 4 && m[3]) return m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0');
        // 无年份的格式 (2个捕获组)
        if (m[1] && m[2]) return m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0');
      }
    }
    return null;
  })();

  // 还款截止日 - 支持"贷记卡到期还款日"、"还款截止日"、"最后还款日"
  const paymentDueDate = (() => {
    const patterns = [
      /(?:贷记卡到期还款日|到期还款日|还款截止日|最后还款日|还款到期日)[：:\s]*(\d{4})年(\d{1,2})月(\d{1,2})日/,
      /(?:还款截止日|最后还款日|到期还款日)[：:]\s*(\d{1,2})[月/-](\d{1,2})/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        if (m.length >= 4 && m[3]) return m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0');
        if (m[1] && m[2]) return m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0');
      }
    }
    return null;
  })();

  // 工行表格行解析：1071(牡丹贷记卡)  3,335.14/RMB  333.51/RMB  10,000.00/RMB
  const icbcRow = text.match(/(\d{4})[（(][^)）]*[)）]\s+([\d,]+\.\d{2})\/RMB\s+([\d,]+\.\d{2})\/RMB\s+([\d,]+\.\d{2})\/RMB/);

  const statementAmount = (() => {
    if (icbcRow) return parseFloat(icbcRow[2].replace(/,/g,''));
    return num([
      /(?:本期账单金额|本期应还金额|应还金额|账单金额)[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
      /应还总额[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
      /应还款额[\s\S]{0,100}?([\d,]+\.\d{2})\/RMB/,
    ]);
  })();

  const minPayment = (() => {
    if (icbcRow) return parseFloat(icbcRow[3].replace(/,/g,''));
    return num([
      /最低还款额?[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
    ]);
  })();

  const creditLimit = (() => {
    if (icbcRow) return parseFloat(icbcRow[4].replace(/,/g,''));
    return num([
      /(?:信用额度|授信额度|信用限额)[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
      /信用额度[\s\S]{0,100}?([\d,]+\.\d{2})\/RMB/,
    ]);
  })();

  return {
    bankName,
    cardLast4,
    billingDate,
    paymentDueDate,
    statementAmount,
    minPayment,
    creditLimit,
    usedAmount: num([
      /(?:已用额度|本期消费|消费总额)[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
      /本期支出[\s\S]{0,50}?([\d,]+\.\d{2})\/RMB/,
    ]),
    availableAmount: num(/可用额度[：:]\s*[¥￥]?([\d,]+\.?\d*)/),
    unbilledAmount: num([
      /(?:未出账单消费|未出账消费|未入账消费|未出账金额)[：:]\s*[¥￥]?([\d,]+\.?\d*)/,
    ]),
  };
}

// ─── 邮件处理 ──────────────────────────────────────────────────────────────

async function handleEmailEvent(message, env) {
  const from = message.from || '';
  const subject = message.headers?.get?.('subject') || '';

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

  const billKeywords = ['账单','还款','信用卡','Credit','Statement','Bill','结单'];
  const isBill = billKeywords.some(k => rawEmail.includes(k) || subject.includes(k));
  if (!isBill) return;

  const parsed = await parseEmailWithAI(rawEmail, env);
  if (!parsed || !parsed.bankName) {
    // 即使解析失败也通知，方便排查
    await sendTelegram(`⚠️ 收到疑似账单邮件但解析失败\n来自：${from}\n主题：${subject}`, env);
    return;
  }

  const cards = await getCards(env);
  const existing = cards.findIndex(c => c.cardLast4 === parsed.cardLast4 && c.bankName === parsed.bankName);
  const card = {
    id: existing >= 0 ? cards[existing].id : genId(),
    ...parsed,
    emailFrom: from,
    updatedAt: new Date().toISOString(),
    source: 'email',
  };

  if (existing >= 0) { cards[existing] = card; } else { cards.push(card); }
  await saveCards(env, cards);

  const msg = `📬 *收到新账单*\n\n` +
    `🏦 ${card.bankName}${card.cardLast4 ? '（····' + card.cardLast4 + '）' : ''}\n` +
    `📅 还款截止：${card.paymentDueDate || '未知'}\n` +
    `💰 本期账单：${card.statementAmount ? '¥' + card.statementAmount.toLocaleString() : '—'}\n` +
    `💳 可用额度：${card.availableAmount ? '¥' + card.availableAmount.toLocaleString() : '—'}`;
  await sendTelegram(msg, env);
}

// ─── TG 推送 ───────────────────────────────────────────────────────────────

async function sendTelegram(text, env) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

function daysUntil(mmdd) {
  if (!mmdd) return null;
  const now = new Date();
  const [mm, dd] = mmdd.split('-').map(Number);
  let due = new Date(now.getFullYear(), mm - 1, dd);
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
    if (days === null)   normal.push({ name, amount, dueStr, days });
    else if (days < 0)   overdue.push({ name, amount, dueStr, days });
    else if (days <= 3)  urgent.push({ name, amount, dueStr, days });
    else                 normal.push({ name, amount, dueStr, days });
  }

  if (overdue.length) {
    lines.push('🔴 *已逾期*');
    overdue.forEach(c => lines.push(`  • ${c.name}｜${c.amount}｜逾期 ${Math.abs(c.days)} 天`));
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
  const stored = await env.CREDIT_CARD_KV.get(`session:${token}`);
  return { ok: !!stored };
}

async function handleLogin(request, env) {
  const { password } = await request.json().catch(() => ({}));
  if (!password || password !== env.ADMIN_PASSWORD) {
    return jsonRes({ error: '密码错误' }, 401);
  }
  const token = genId() + genId();
  await env.CREDIT_CARD_KV.put(`session:${token}`, '1', { expirationTtl: 604800 });
  return jsonRes({ token });
}

// ─── API 路由 ──────────────────────────────────────────────────────────────

async function apiGetCards(env) {
  return jsonRes(await getCards(env));
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
  const existing = cards.findIndex(c => c.cardLast4 === parsed.cardLast4 && c.bankName === parsed.bankName);
  const card = { id: existing >= 0 ? cards[existing].id : genId(), ...parsed, updatedAt: new Date().toISOString(), source: 'manual' };
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
  async email(message, env, ctx) {
    ctx.waitUntil(handleEmailEvent(message, env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsRes();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/login' && request.method === 'POST') return handleLogin(request, env);

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
    if (path === '/api/parse' && request.method === 'POST') return apiParseEmail(request, env);
    if (path === '/api/push'  && request.method === 'POST') return apiTriggerPush(env);

    return jsonRes({ error: 'Not Found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  },
};
