# 信用卡账单管理系统

基于 Cloudflare Worker + KV + AI 实现的信用卡账单自动解析、展示、TG 推送系统。

## 功能清单

- ✅ 自动接收信用卡账单邮件并解析关键信息（Cloudflare AI / 正则兜底）
- ✅ 账单数据可视化展示（表格 + 还款提醒高亮 + 逾期/紧急标记）
- ✅ 账单数据编辑 / 删除 / 手动添加 / 手动刷新
- ✅ 每日定时 TG 推送账单提醒（支持逾期 / 紧急 / 正常分类）
- ✅ 邮件自动到达即时 TG 通知
- ✅ 管理员密码鉴权，防止未授权访问

---

## 项目结构

```
credit-card-manager/
├── .github/
│   └── workflows/
│       └── deploy.yml        # GitHub Actions 自动部署
├── worker/
│   ├── wrangler.toml         # Cloudflare Worker 配置
│   └── src/
│       └── index.js          # Worker 主逻辑（邮件/API/Cron）
├── frontend/
│   └── index.html            # 前端管理界面
└── README.md
```

---

## 部署步骤

### 1. 前置准备

- 拥有 Cloudflare 账户并绑定域名
- 申请 Telegram Bot Token（[@BotFather](https://t.me/BotFather)）
- 获取 Telegram Chat ID（[@userinfobot](https://t.me/userinfobot)）
- 创建 Cloudflare API Token（需包含 Worker / KV / AI / Email Routing 权限）

### 2. 创建 KV 命名空间

在 Cloudflare 控制台 → Workers & Pages → KV：

1. 点击「Create namespace」
2. 名称填写 `CREDIT_CARD_KV`
3. 记录生成的 **KV ID**
4. 打开 `worker/wrangler.toml`，将 `YOUR_KV_NAMESPACE_ID_HERE` 替换为实际 ID

### 3. Fork 仓库并配置 GitHub Secrets

进入仓库「Settings → Secrets and variables → Actions」添加：

| Secret 名称 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

### 4. 配置 Worker 环境变量

部署完成后，进入 Cloudflare 控制台 → Workers → `credit-card-manager` → Settings → Variables → **Secrets**，添加：

| 变量名 | 说明 |
|---|---|
| `TG_BOT_TOKEN` | Telegram Bot Token |
| `TG_CHAT_ID` | Telegram Chat ID |
| `ADMIN_PASSWORD` | 前端管理界面登录密码 |

### 5. 配置 Email Routing（核心：接收账单邮件）

1. 进入 Cloudflare 控制台 → 你的域名 → **Email → Email Routing** → 启用
2. 按提示完成 DNS 配置（自动生成 MX 记录，等待 5–30 分钟生效）
3. 创建转发规则：
   - **Recipient email**：`bills@your-domain.com`（银行账单转发到此地址）
   - **Action**：选择「Send to a Worker」→ 选择 `credit-card-manager`
4. 保存后，发送到该地址的邮件会自动被 Worker 解析

> **提示**：将各银行账单通知邮件的接收地址改为 `bills@your-domain.com`，或在邮件客户端设置转发规则。

### 6. 配置 Cron 定时推送

进入 Worker → Triggers → 确认 Cron 已启用：

```
0 1 * * *   # UTC 01:00 = 北京时间 09:00
```

可按需修改时间。

### 7. 配置前端

打开 `frontend/index.html`，找到以下行并替换为你的 Worker 域名：

```javascript
const BASE_URL = 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev';
```

然后将 `frontend/index.html` 部署到任意静态托管（Cloudflare Pages / GitHub Pages / Nginx 均可）。

### 8. 推送代码触发自动部署

```bash
git add .
git commit -m "deploy"
git push origin main
```

GitHub Actions 将自动部署 Worker。

---

## API 说明

所有接口（除 `/api/login`）均需在 Header 中携带：

```
Authorization: Bearer <token>
```

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 登录，返回 token |
| GET | `/api/cards` | 获取所有卡片账单 |
| POST | `/api/cards` | 手动添加卡片 |
| PUT | `/api/cards/:id` | 更新卡片信息 |
| DELETE | `/api/cards/:id` | 删除卡片 |
| POST | `/api/parse` | 解析邮件文本并存入 |
| POST | `/api/push` | 手动触发 TG 推送 |

---

## TG 推送示例

**邮件到达即时通知：**
```
📬 收到新账单

🏦 工商银行（····6688）
📅 还款截止：03-25
💰 本期账单：¥3,256.80
💳 可用额度：¥37,660.00
```

**每日定时日报：**
```
📊 信用卡还款日报 — 2025/3/22

🔴 已逾期
  • 招商银行····1234｜¥5,000.00｜逾期 2 天

🟠 紧急提醒（3天内到期）
  • 工商银行····6688｜¥3,256.80｜还剩 1 天

🟢 正常账单
  • 建设银行····4521｜¥8,760.20｜还剩 15 天

💰 本期合计应还：¥17,016.80
💳 可用额度合计：¥106,449.80
```
