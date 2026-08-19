---
name: tml-qr
description: 当用户要求输出通明湖消费二维码/付款码时使用。运行内置脚本从 TML 取码并生成本地 PNG，支持多账号。
version: 1.1.0
author: Hex
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [qrcode, payment, tml, feishu]
    related_skills: []
---

# 通明湖付款码（TML QR）输出

从通明湖（TML）消费系统获取付款码内容并渲染成 PNG，供 AI Agent 在对话中直接发给用户。不依赖飞书机器人、定时任务或长连接监听——只有用户主动索要时才取码。支持多账号（手机号/昵称索引）与按账号取码。

## When to Use

用户说「输出通明湖二维码」「通明湖二维码」「通明湖付款码」等时，可带或不带账号（手机号/昵称）。只响应当前对话里的主动索要，不泛化到普通二维码。

## 前置依赖

- Node.js >= 20.18.1（脚本用原生 `fetch`，无额外 HTTP 库）
- `qrcode` 包。本仓库根 `package.json` 已依赖它，在仓库根执行 `pnpm install` 即可；若单独抽出本 skill，则在 skill 目录执行 `pnpm add qrcode`

## 凭证与多账号存储

凭证存于 `skills/tml-qr/users.json`（权限 600，已被 `.gitignore` 忽略），按手机号索引，登录成功后由登录脚本写入：

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

`loginsession` 是登录会话，过期后重新登录即可更新。若 `users.json` 不存在，脚本回退读取旧版单账号 `.env`（`TML_USER_ID` + `TML_LOGIN_SESSION`）作为默认账号。

可配置环境变量：`TML_USERS_FILE`（users.json 路径）、`TML_ENV_FILE`（旧版 .env 路径）、`TML_QR_OUTPUT`（PNG 输出路径）。

## 账号解析规则

用户指定账号（手机号或昵称）时：

1. 输入是手机号 → 精确命中 `users` 的 key
2. 输入是昵称 → 唯一匹配则直接用；多个账号同名时脚本报错，Agent 应调用 `list` 列出候选（昵称 + 脱敏手机号）反问用户确定哪个
3. 未指定账号 → 用 `default`；单账号时即用那个；多账号且无默认时报错提示指定

## 步骤

1. 取码（`--user` 可选，不带则用默认账号）：
   ```bash
   node skills/tml-qr/scripts/fetch-tml-qr.mjs --user 手机号或昵称
   ```
2. 成功时 stdout 是一行 JSON：
   ```json
   {"qrPath":".../consume-qr.png","phone":"138...","nickname":"小王","personalBalance":"12.00","bookkeepingBalance":"45.00"}
   ```
   两个余额字段可能为 null（相应接口失败时降级）。
3. 把 `qrPath` 指向的图片发给用户；飞书/Hermes 环境输出 `MEDIA:<qrPath>`。
4. 余额非 null 时，附带「个人充值：<personalBalance> 元」「记账充值：<bookkeepingBalance> 元」，并带上账号标识（昵称或脱敏手机号）。
5. 脚本 exit 非 0 时，把 stderr 原样告诉用户；「没有登录的账号」或凭证失效时引导用户走登录流程。

## 管理命令

```bash
node skills/tml-qr/scripts/tml-users.mjs list                            # 列出账号（脱敏手机号 + 昵称 + 是否默认）
node skills/tml-qr/scripts/tml-users.mjs remove --user 手机号或昵称       # 删除账号
node skills/tml-qr/scripts/tml-users.mjs set-default --user 手机号或昵称  # 设默认账号
node skills/tml-qr/scripts/tml-users.mjs add --phone ... --nickname ... --userId ... --loginsession ...  # 手动添加（登录接口未就绪时的兜底）
```

## 登录流程

登录接口就绪后由 `tml-auth.mjs` 提供 `send-code` / `login` 两个子命令，Agent 按「问手机号 → 发验证码 → 问验证码 → 登录 → 写入 users.json」编排。

## 输出字段

- `qrPath`：生成的 600×600 PNG 绝对路径
- `phone` / `nickname`：命中的账号标识
- `personalBalance`：个人充值余额（元）。`queryBalance.totalBalance` 源单位是分、脚本已除 100
- `bookkeepingBalance`：记账充值余额（元）。`bookkeepingRechargebalanceBalance/paginQuery.consumptionBalance` 源单位即元