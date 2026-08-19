---
name: tml-qr
description: 当用户要求输出通明湖付款码/二维码时使用。调用内置脚本取码生成 PNG 并附余额，支持多账号。
version: 1.2.0
author: Hex
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [qrcode, payment, tml]
    related_skills: []
---

# 通明湖付款码

按需从通明湖（TML）消费系统取付款码 PNG 发给用户。支持多账号，按手机号/昵称索引。只在用户主动索要时取码，不做定时或机器人推送。

## When to Use

用户消息里出现「通明湖二维码 / 通明湖付款码」，或要求列账号、删账号、设默认、登录某个手机号时。

## 账号解析

用户可能用手机号、昵称或都不指定：

1. 手机号 → `users.json` 精确命中
2. 昵称 → 唯一则直接用；多个同名 → 跑 `list` 列出候选（昵称 + 脱敏手机号）反问用户确定哪个
3. 未指定 → 用默认账号；单账号即它；多账号无默认 → 反问

## 命令

脚本在本 skill 的 `scripts/` 目录下。依赖 Node >= 20 + `qrcode` 包（仓库根已含，单抽本 skill 时 `pnpm install` 安装）。

```bash
# 取码（--user 可省，默认账号）
node scripts/fetch-tml-qr.mjs [--user 手机号|昵称]

# 账号管理
node scripts/tml-users.mjs list
node scripts/tml-users.mjs remove --user 手机号|昵称
node scripts/tml-users.mjs set-default --user 手机号|昵称
node scripts/tml-users.mjs add --phone ... --nickname ... --userId ... --loginsession ...
```

## 输出

取码成功 stdout 一行 JSON：

```json
{"qrPath":"/abs/path.png","phone":"158...","nickname":"Hex","personalBalance":"12.00","bookkeepingBalance":"0.10"}
```

- 把 `qrPath` 的图发给用户：飞书/Hermes 用 `MEDIA:<qrPath>`，其它平台用对应传图方式
- 两个余额单位已是元，可能为 null（对应接口失败时降级）
- 附余额时带上账号标识（`nickname` 或脱敏手机号）

## 凭证与登录

- 凭证在 `users.json`（600 权限，勿提交），结构 `{default, users: {手机号: {nickname, userId, loginsession}}}`，登录后自动写入
- 凭证失效或新增账号时，按「问手机号 → 发验证码 → 问验证码 → 登录」编排：

```bash
node scripts/tml-auth.mjs send-code --phone 手机号                             # 发码，响应 body.smsId 供登录用
node scripts/tml-auth.mjs login --phone 手机号 --code 验证码 --smsId <id>      # 登录，自动写 users.json 并设默认
```

发码约 60 秒间隔勿频繁；登录为单会话，会顶掉该号旧凭证。

## 异常

脚本 exit 非 0 → 把 stderr 原样转告用户。常见：凭证过期（引导登录）、昵称重名或不存在（跑 `list` 确认）、未登录任何账号（引导登录）。