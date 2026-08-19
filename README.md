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

编辑 `.env`，至少填写飞书应用信息：

```dotenv
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_RECEIVE_ID=ou_...
FEISHU_RECEIVE_ID_TYPE=open_id
```

`TML_USER_ID`/`TML_LOGIN_SESSION` 现为**可选**：留空时由 `users.json` 的默认账号提供凭证（推荐经飞书「登录」自助获取，见第 6 节）。填写则优先使用，向后兼容旧抓包配置。

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
@机器人 二维码 15812345678          # 用指定账号取码（不改默认账号）
@机器人 重发二维码 15812345678       # 同上
```

不要提交 `.env`。登录会话过期后，在飞书里重新发送「@机器人 登录 手机号」即可刷新（见第 6 节），无需改 `.env`；若仍用旧抓包方式，则更新 `TML_LOGIN_SESSION`。

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

每次发送都会同时查询当前账户余额。成功后飞书会收到标题格式为 `【2026年8月18日】通明湖付款码 当前余额：60.0 元` 的二维码消息，日期按北京时间生成，余额来自 TML 账务接口返回的 `consumptionBalance`。控制台不会打印二维码内容、余额、会话或飞书密钥。失败时，程序会尝试向同一飞书接收人发送文字告警。

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

## 5. 给 AI Agent 使用的 Skill（无需飞书机器人）

如果不想部署飞书自建应用、定时任务和长连接监听，只想在对话中让 AI Agent 按需取码，本仓库提供了 `skills/tml-qr/` 这个通用 Skill（兼容 Claude Code、Hermes、Codex、Cursor 等支持 Skill 的 Agent）。

它复用同一套 TML 接口，但只保留「取码 + 生成 PNG」两步，不依赖飞书机器人。Agent 识别到「输出通明湖二维码 / 通明湖付款码」后，运行内置脚本并把生成的 PNG 发给用户。

### 5.1 安装

把 `skills/tml-qr/` 挂到你的 Agent 的 skills 目录。以 Claude Code 为例：

```bash
ln -s "$(pwd)/skills/tml-qr" ~/.claude/skills/tml-qr
```

（Hermes 为 `~/.hermes/skills/tml-qr`，其他 Agent 依其 skills 目录约定而定。）依赖 `qrcode` 已包含在本仓库根 `package.json` 中，在仓库根执行过 `pnpm install` 即可。

### 5.2 配置凭证（多账号）

凭证存于 `skills/tml-qr/users.json`（权限 600，已被 `.gitignore` 忽略），按手机号索引、每账号带昵称，登录成功后由登录脚本写入：

```json
{
  "default": "13800000000",
  "users": {
    "13800000000": {
      "nickname": "小王",
      "userId": "55053fa...",
      "loginsession": "06c15978..."
    }
  }
}
```

`loginsession` 是登录会话，过期后重新登录即可更新。`users.json` 不存在时会回退读取旧版单账号 `.env`（`TML_USER_ID` + `TML_LOGIN_SESSION`）作为默认账号。

### 5.3 取码与账号管理

```bash
node skills/tml-qr/scripts/fetch-tml-qr.mjs --user 手机号或昵称         # 取码（不带 --user 用默认账号）
node skills/tml-qr/scripts/tml-users.mjs list                          # 列出账号
node skills/tml-qr/scripts/tml-users.mjs remove --user 手机号或昵称     # 删除账号
node skills/tml-qr/scripts/tml-users.mjs set-default --user 手机号或昵称 # 设默认账号
```

取码成功时输出一行 JSON：`{"qrPath":"...","phone":"138...","nickname":"小王","personalBalance":"12.00","bookkeepingBalance":"45.00"}`，个人充值与记账充值分别来自不同接口、单位已换算为元。Agent 据此把 PNG 发给用户即可。

具体的触发词、输出字段和降级行为，见 `skills/tml-qr/SKILL.md`。

## 6. 飞书内登录与账号管理

凭证不再需要手动抓包。监听服务启动后（即使尚未配置任何账号），在私聊或授权群聊里直接与机器人对话即可完成登录、验证和账号管理：

```text
@机器人 登录 15812345678          # 发送短信验证码，建立 60 秒登录会话
@机器人 验证码 123456             # 用收到的 6 位验证码登录，自动写入 users.json 并设为默认
@机器人 123456                    # 也可直接回复 6 位数字作为验证码（需有进行中会话）
@机器人 取消登录                   # 放弃当前登录会话
@机器人 账号                       # 列出已登录账号（脱敏手机号 + 昵称，★ 标记默认）
@机器人 切换 15812345678           # 切换默认账号（可用手机号或昵称）
@机器人 帮助                       # 查看机器人支持的全部命令（也可发「功能」/「功能介绍」）
```

登录成功后，定时任务（08:30/11:30）与即时触发（`@机器人 二维码`）会自动使用默认账号取码，无需修改 `.env`。凭证过期重登即可。登录/验证/账号管理命令**不会**进入二维码发送队列、不触发冷却与去重，与取码流程完全隔离。

相关配置（默认值见 `.env.example`）：

- `FEISHU_LOGIN_INTERACTION_ENABLED=true`：总开关，关闭后机器人不再响应登录类命令。
- `FEISHU_LOGIN_BARE_CODE_ENABLED=true`：是否允许直接回复 6 位数字作为验证码。
- `FEISHU_LOGIN_SESSION_TTL_MS=60000`：登录会话有效期，超时需重新发码。

CLI 仍可管理账号（`node src/tml-users.mjs list/remove/set-default/add`、`node src/tml-auth.mjs send-code/login`），与飞书内操作写同一个 `users.json`。

注意事项：

- 登录命令仅授权发送者（`FEISHU_TRIGGER_SENDER_IDS`）或授权群聊（`FEISHU_TRIGGER_CHAT_IDS`）可发起；未授权静默拒绝。
- 回复中手机号一律脱敏；但发起者在群聊里输入的明文手机号会留在群历史，如需保密请私聊机器人。
- 短信登录命令走直连（不走 `TML_HTTP_PROXY`）。需代理网络的部署请用 CLI 或后续扩展。
- 从旧 `.env` 抓包方式迁移到 `users.json`：清空 `.env` 里的 `TML_USER_ID`/`TML_LOGIN_SESSION` 即可让程序改读 `users.json` 默认账号；两者共存时 `.env` 优先。

## 安全说明

- TML 登录会话与二维码都应视为敏感凭证。
- `.env` 安装时会被设置为仅当前用户可读写。
- 临时二维码创建在操作系统临时目录中，并在成功或失败后删除。
- 即时触发任务保存在权限为 `0700/0600` 的 `.runtime` 目录，并使用消息 ID 去重；成功和失败标记用于拦截飞书重推。
- 同一群聊默认有 10 秒触发冷却，避免连续 @造成重复发送。
- 定时任务和即时触发共用跨进程锁，不会并发获取或发送二维码。
- API 错误日志不会输出响应原文，避免意外记录二维码内容。
