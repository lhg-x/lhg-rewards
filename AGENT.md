# AI Agent 自动化部署与运行手册（`AGENT.md`）

本文档专供 AI Agent（如 muse.ai / Codex / Claude Code 等自动化机器人）无歧义执行。**请严格按以下固定步骤操作，不要自行绕路登录 `outlook.live.com` 或修改无关代码。**

---

## 一、环境初始化（仅首次执行）

```bash
git clone -b V4-china https://github.com/lhg-x/lhg-rewards.git
cd lhg-rewards
npm install
npx patchright install chromium
npm run build
```

---

## 二、写入配置（`.env` 与 `config.json`）

### 1. 生成 `.env`

```bash
cp env.example .env
```

按用户提供的账号信息填写 `.env`（**务必同时填写恢复邮箱与恢复邮箱密码**，脚本内置纯 HTTP 自动取码，无需交互终端也无需额外开浏览器登录辅助邮箱）：

```dotenv
ACCOUNT_1_EMAIL=主邮箱@outlook.com
ACCOUNT_1_PASSWORD=主密码
ACCOUNT_1_RECOVERY_EMAIL=辅助邮箱@pyyemail.cc
ACCOUNT_1_RECOVERY_PASSWORD=辅助邮箱密码
ACCOUNT_1_RECOVERY_URL=https://pyyemail.cc
# 海外号填 auto / en；若统一在国内兑换（国区模式），必须填 CN / zh-CN 并留空所有代理
ACCOUNT_1_GEO_LOCALE=CN
ACCOUNT_1_LANG_CODE=zh-CN
ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=true
ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=true
```

### 2. 使用 Agent 专用配置 `config.agent.json`

```bash
cp config.agent.json config.json
```

`config.agent.json` 已预置：
- `headless: true`（适配无显示器云端/容器环境）
- 全流程可领积分开关全部开启（每日集 / 更多促销 / 打卡 / App 活动 / 桌面与移动搜索 / 加成搜索 / 签到 / 阅读赚取 / 视觉搜索）
- 合理的延迟（`searchDelay: 20sec~40sec`、`readDelay: 15sec~25sec`），避免单次运行超时
- `humanize.skipWhenCompletedToday: true`（当天已完成后自动跳过，支持安全重试）

> 若账号为海外区，可把 `config.json` 中 `searchSettings.queryEngines` 改为 `["google", "wikipedia", "local"]` 或保留 `["china", "local"]`。

---

## 二点五、国区统一模式：把所有账号地区设为中国

Microsoft Rewards 严格执行**“在哪国赚、在哪国兑”**规则（不支持美区/日区直接用国内 `+86` 手机号兑换）。如果需要在**中国大陆直连网络下赚取并兑换**（京东 E 卡 / 盒马 / 天猫超市等），请按以下规则执行：

1. **三层必须同时对齐中国大陆（CN）**：
   - **微软账号资料地区**：`account.microsoft.com/profile` 中的国家/地区设为 `China` / `中国大陆`。
   - **本地配置与会话**：`.env` 设置 `ACCOUNT_N_GEO_LOCALE=CN`、`ACCOUNT_N_LANG_CODE=zh-CN`，且清除所有海外代理（`ACCOUNT_N_PROXY_*` 留空）。
   - **运行网络环境**：全程使用**中国大陆直连 IP**（不要挂境外 VPN/代理运行）。
2. **执行一键迁移命令（首次配置或从美/日区转回国区时跑一次）**：
   ```bash
   npm run set-region -- --country CN --update-env --clear-proxy --json
   ```
   - 该命令会自动登录 `account.microsoft.com/profile`（含 `pyyemail.cc` 自动 2FA 接码），将资料地区改为中国大陆，清掉 `sessions.db` 中旧美/日区指纹，并同步更新 `.env`。
   - 如果已在网页手动改过资料地区，只需同步本地配置和指纹缓存，可加 `--local-only`：
     ```bash
     npm run set-region -- --country CN --local-only --update-env --clear-proxy --json
     ```
3. **迁移冷却期（`On the go`）处理原则（重要）**：
   - 原本在美区/日区活跃的号刚切回中国大陆直连 IP 时，Rewards 页面前 1–7 天可能出现 *"Oops, looks like you're on the go"*（"哎呀，看起来你在外出"）提示，属于微软地区迁移冷却期。
   - **遇到该提示时严禁切回海外代理或反复切换地区**！请保持中国直连 IP、`CN / zh-CN` 配置每天运行一次 `npm start`，等待微软后台自动把该账号的 Rewards 市场迁入 CN。
4. **国区兑换提醒**：
   - 国区兑换礼品卡需绑定中国大陆 `+86` 实体手机号收短信验证码（VoIP 虚拟号不可用），且微软通常限制**单个手机号最多绑定约 6 个 Rewards 账号**。

---

## 三、环境与网络自检（必跑）

```bash
npm run doctor -- --json
```

- 检查输出中所有项均为 `ok`（或仅 `sessions_db` 为 `warn` 尚未建立会话）。
- **如果 `browser_network` 报 `fail`（如 `ERR_TUNNEL_CONNECTION_FAILED`）**：说明当前云端沙盒出口代理拦截了 Chromium，**立即停止并向用户汇报**，不要反复重试。

---

## 四、首次登录并建立持久会话（二选一）

`lhg-rewards` 的持久会话保存在 `sessions/sessions.db`（分 `desktop` 与 `mobile` 两条记录），**不要**单独去登录 `outlook.live.com` 以为能共享 Cookie。

### 方式 A（推荐，全自动无头，无需人工审批）

只要 `.env` 已配置 `ACCOUNT_1_RECOVERY_EMAIL` + `ACCOUNT_1_RECOVERY_PASSWORD`，直接运行一次主流程即可自动完成密码登录 + 恢复邮箱 2FA 取码 + KMSI 保持登录 + 会话入库：

```bash
npm start
```

### 方式 B（使用外部有头云端浏览器建 Cookie 时）

如果必须通过外部有头浏览器人工/半自动登录：
1. 在有头浏览器中访问 `https://rewards.bing.com/auth/login`（**不是** `outlook.live.com`）完成登录；遇到「保持登录状态」勾选不再显示并点「是」。
2. 导出该浏览器的 Cookies（支持 Playwright `storageState` JSON 或浏览器插件导出的 Cookie 数组 JSON）保存为 `cookies.json`。
3. 导入到本项目的 `sessions/sessions.db`：
   ```bash
   npm run import-session -- --email 主邮箱@outlook.com --file cookies.json --platform both
   ```
4. 导入后立刻删除临时文件 `cookies.json`，再运行 `npm start` 验证。

---

## 五、每日定时执行

- 验证 `npm start` 能正常打印桌面/移动积分统计后，配置每天固定时间（建议每日 08:00）在项目根目录执行：
  ```bash
  npm start
  ```
- 若使用系统 `crontab`：
  ```cron
  0 8 * * * cd /path/to/lhg-rewards && npm start >> logs/cron.log 2>&1
  ```
- 每日运行结束后，从 `logs/YYYY-MM-DD.log` 提取本次获得的积分数与总余额汇报给用户。
