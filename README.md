# TMH 每日二维码 → 飞书

每天北京时间 08:30 和 11:30 请求 TML 消费二维码接口，生成临时 PNG，通过飞书自建应用机器人发送给指定会话。08:30 的消息标题为“今日早餐二维码”，11:30 的消息标题为“今日午餐二维码”。发送成功后删除临时二维码。

运行环境需要 Node.js 20.18.1 或更高版本，并使用 pnpm 安装锁定依赖。

## 1. 配置飞书应用

1. 在飞书开放平台创建企业自建应用并开启“机器人”能力。
2. 申请 `im:message:send_as_bot` 和 `im:resource` 权限，发布应用。
3. 将收件人加入应用可用范围。
4. 获取应用的 App ID、App Secret，以及收件人的 `open_id`（`ou_...`）。

如果使用 `user_id`、`union_id`、邮箱或群聊 ID，请同步修改 `FEISHU_RECEIVE_ID_TYPE`。发到群聊时，机器人必须已加入该群，并将类型设为 `chat_id`。

## 2. 安装与填写环境变量

```bash
pnpm install --frozen-lockfile
chmod 600 .env
```

项目已经生成空白 `.env`；如果它被删除，可用 `cp .env.example .env` 重新创建。

编辑 `.env`，至少填写：

```dotenv
TML_USER_ID=...
TML_LOGIN_SESSION=...
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_RECEIVE_ID=ou_...
FEISHU_RECEIVE_ID_TYPE=open_id
```

不要提交 `.env`。登录会话过期后，只需要更新 `TML_LOGIN_SESSION`，无需修改代码。

填写后先执行只读配置校验（不会发起网络请求）：

```bash
pnpm config:check
```

原始抓包命令中的 `--proxy http://localhost:9090` 通常只用于调试。如果运行时仍必须经过该代理，再设置：

```dotenv
TML_HTTP_PROXY=http://localhost:9090
```

该代理只用于请求 TML，不会代理飞书请求。

## 3. 手动验证

```bash
pnpm send
```

手动测试指定文案时，可以覆盖时间判断：

```bash
MEAL_TYPE=breakfast pnpm send
MEAL_TYPE=lunch pnpm send
```

成功后飞书会收到二维码，控制台不会打印二维码内容、会话或飞书密钥。失败时，程序会尝试向同一飞书接收人发送文字告警。

如果只在调试时需要检查生成的 PNG：

```dotenv
KEEP_QR=true
QR_OUTPUT_PATH=consume-qr.png
```

生产环境建议保持 `KEEP_QR=false`。

## 4. 启用每日 08:30 和 11:30 定时任务

Linux/systemd 用户服务：

```bash
chmod +x scripts/install-user-timer.sh
./scripts/install-user-timer.sh
```

检查状态和日志：r

```bash
systemctl --user status tml-feishu-qr.timer
journalctl --user -u tml-feishu-qr.service -n 100 --no-pager
```

立即触发一次定时服务：

```bash
systemctl --user start tml-feishu-qr.service
```

停止定时任务：

```bash
systemctl --user disable --now tml-feishu-qr.timer
```

`Persistent=true` 会在机器错过 08:30 后、下次开机时补跑。若希望退出登录后仍能运行，管理员需要执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

## 安全说明

- TML 登录会话与二维码都应视为敏感凭证。
- `.env` 安装时会被设置为仅当前用户可读写。
- 临时二维码创建在操作系统临时目录中，并在成功或失败后删除。
- API 错误日志不会输出响应原文，避免意外记录二维码内容。
