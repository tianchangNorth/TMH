# TMH 每日二维码 → 飞书

该项目可以自动获取 TMH APP 消费二维码接口，生成临时 PNG，通过飞书自建应用机器人发送。支持每天 08:30、11:30 定时发送，也支持在飞书群聊中 @机器人后立即重新生成并发送到当前会话。发送成功后删除临时二维码。

运行环境需要 Node.js 20.18.1 或更高版本，并使用 pnpm 安装锁定依赖。

## 1. 配置飞书应用

1. 在飞书开放平台创建企业自建应用并开启“机器人”能力。
2. 申请以下应用身份权限：
   - `im:message:send_as_bot`：以机器人身份发送消息。
   - `im:resource`：上传二维码图片。
   - `im:message.group_at_msg:readonly`：接收群聊中 @机器人的消息。
3. 将收件人加入应用可用范围。
4. 获取应用的 App ID、App Secret，以及收件人的 `open_id`（`ou_...`）。
5. 订阅“接收消息 v2.0”事件 `im.message.receive_v1`，并在监听服务启动后将事件接收方式设置为“使用长连接接收事件”。
6. 发布应用，使权限和事件配置生效。

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

即时触发默认沿用定时收件人作为白名单：

- `FEISHU_RECEIVE_ID_TYPE=open_id/user_id/union_id` 时，只允许该用户触发。
- `FEISHU_RECEIVE_ID_TYPE=chat_id` 时，只允许该群触发。

如需允许其他人员或群聊，填写多个 ID（英文逗号分隔）：

```dotenv
FEISHU_TRIGGER_CHAT_IDS=oc_xxx,oc_yyy
FEISHU_TRIGGER_SENDER_IDS=ou_xxx,ou_yyy
```

群聊请求满足“允许的群聊或允许的发送者”任一条件即可触发，二维码会发送回发起请求的群聊。默认支持以下文本：

```text
@机器人
@机器人 二维码
@机器人 重发二维码
```

不要提交 `.env`。登录会话过期后，只需要更新 `TML_LOGIN_SESSION`，无需修改代码。

填写后先执行只读配置校验（不会发起网络请求）：

```bash
pnpm config:check
pnpm listen:check
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

每次发送都会同时查询当前账户余额。成功后飞书会收到标题格式为 `【2026年8月18日】通明湖付款码 当前余额：123.45 元` 的二维码消息，日期按北京时间生成，余额来自 TML 返回的 `totalBalance`。控制台不会打印二维码内容、余额、会话或飞书密钥。失败时，程序会尝试向同一飞书接收人发送文字告警。

如果只在调试时需要检查生成的 PNG：

```dotenv
KEEP_QR=true
QR_OUTPUT_PATH=consume-qr.png
```

生产环境建议保持 `KEEP_QR=false`。

## 4. 启用定时任务和飞书长连接监听

Linux/systemd 用户服务：

```bash
chmod +x scripts/install-user-timer.sh
./scripts/install-user-timer.sh
```

检查状态和日志：

```bash
systemctl --user status tml-feishu-qr.timer
journalctl --user -u tml-feishu-qr.service -n 100 --no-pager
systemctl --user status tml-feishu-listener.service
journalctl --user -u tml-feishu-listener.service -n 100 --no-pager
```

监听服务显示为 `active (running)` 后，在飞书开放平台的“事件与回调 → 事件配置”中选择“使用长连接接收事件”。飞书要求至少有一个长连接在线后才能保存该设置。

立即触发一次定时服务：

```bash
systemctl --user start tml-feishu-qr.service
```

停止定时任务和即时监听：

```bash
systemctl --user disable --now tml-feishu-qr.timer tml-feishu-listener.service
```

`Persistent=true` 会在机器错过 08:30 后、下次开机时补跑。若希望退出登录后仍能运行，管理员需要执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

## 安全说明

- TML 登录会话与二维码都应视为敏感凭证。
- `.env` 安装时会被设置为仅当前用户可读写。
- 临时二维码创建在操作系统临时目录中，并在成功或失败后删除。
- 即时触发任务保存在权限为 `0700/0600` 的 `.runtime` 目录，并使用消息 ID 去重；成功和失败标记用于拦截飞书重推。
- 同一群聊默认有 10 秒触发冷却，避免连续 @造成重复发送。
- 定时任务和即时触发共用跨进程锁，不会并发获取或发送二维码。
- API 错误日志不会输出响应原文，避免意外记录二维码内容。
