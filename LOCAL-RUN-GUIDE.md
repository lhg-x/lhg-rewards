# 微软刷分脚本 · 本机运行备用方案（Mac）

> 背景：沙盒里 Chromium 走出口代理上网被拦（curl 正常、浏览器报 ERR_TUNNEL_CONNECTION_FAILED），
> 若沙盒首次登录同样出不去，改在你自己电脑上跑——家用宽带直连，无代理问题。
> 本机跑通后，后续每天的定时任务也建议留在这台电脑上（或任何能正常上网的机器），别迁回沙盒。

## 一、环境要求

- Node.js **≥ 24**（项目 package.json 要求）。没有的话先装：
  ```bash
  # 有 Homebrew：
  brew install node@24
  # 或去 https://nodejs.org 装 LTS
  node -v   # 确认 ≥ v24
  ```

## 二、安装（10 分钟，一次即可）

```bash
git clone https://github.com/chiihero/Microsoft-Rewards-Script.git ms-rewards
cd ms-rewards
git checkout V4-china
git log --oneline -1   # 确认 e0c15a6（v4.3.2.4）
npm i                  # 装依赖
npx patchright install chromium   # 装浏览器内核（本机直连，一般不被拦）
npm run build          # 构建，dist/index.js 生成即成功
```

## 三、配置账号（你亲手填）

```bash
cp env.example .env
```

用编辑器打开 `.env`，按这个最小配置填（别的不用动）：

```
ACCOUNT_1_EMAIL=你的微软账号邮箱
ACCOUNT_1_PASSWORD=你的密码
ACCOUNT_1_LANG_CODE=zh-CN
ACCOUNT_1_GEO_LOCALE=CN
ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=true
ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=true
```

- 账号开了两步验证：首次运行时留意终端提示，手机上点批准即可；之后会话持久化，不用再输密码。
- 国内查询源默认就是 `china,local`（百度/头条/抖音/微博/知乎热搜），不用改。
- `.env` 已在 `.gitignore` 里，不会进 git；但别发给别人。

## 四、首次运行（手动一次，看着它登录）

```bash
npm start
```

成功标志：终端打出每日任务完成日志、无登录报错。
会话会持久化保存——之后密码不再被需要，建议把 `.env` 里的 `ACCOUNT_1_PASSWORD` 那行删掉或留空。

## 五、每天自动跑（Mac 定时）

项目自带 `CRON_SCHEDULE`（默认 `0 7 * * *` 每天 7 点）+ Docker 内置 cron；
本机不用 Docker 的话，用 macOS 的 launchd 或简单 cron：

```bash
crontab -e
# 加一行（每天 8:00 跑，按你实际路径改）：
0 8 * * * cd ~/ms-rewards && /opt/homebrew/bin/npm start >> ~/ms-rewards/logs/cron.log 2>&1
```

配合 `humanize.skipWhenCompletedToday`（默认行为：当天已成功则再次启动直接退出），
可设早晚两个时间点，晚上的那次当"兜底"自动跳过。

## 六、已知的沙盒限制（仅供参考）

沙盒机房出口代理对 Chromium 客户端有限制：同代理下 curl 访问 rewards.bing.com 正常，
但 Chromium 报 `ERR_TUNNEL_CONNECTION_FAILED`。这是代理层行为，非配置问题——
所以本机直连跑是正解，不用在沙盒这边再折腾代理写法。

## 七、风险提醒（之前跟你说过的，再贴一次）

自动化刷分违反微软服务条款，有封号和积分清零风险；
脚本带反检测+拟人化模式，能降低但不能消除。本机家用 IP 比机房 IP 更不容易被识别，
这也是建议本机跑的另一个理由。

---
生成时间：2026-10-10（与沙盒部署版同项目同版本 v4.3.2.4，配置键一致，.env 可互换）
