---
name: tml-qr
description: 当用户要求输出通明湖消费二维码/付款码时使用。运行内置脚本从 TML 取码并生成本地 PNG 图片。
version: 1.0.0
author: Hex
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [qrcode, payment, tml, feishu]
    related_skills: []
---

# 通明湖付款码（TML QR）输出

从通明湖（TML）消费系统获取付款码内容并渲染成 PNG，供 AI Agent 在对话中直接发给用户。不依赖飞书机器人、定时任务或长连接监听——只有用户主动索要时才取码。

## When to Use

用户说「输出二维码」「二维码」「付款码」「通明湖付款码」等时。只响应当前对话里的主动索要。

## 前置依赖

- Node.js >= 20.18.1（脚本用原生 `fetch`，无额外 HTTP 库）
- `qrcode` 包。本仓库根 `package.json` 已依赖它，在仓库根执行 `pnpm install` 即可；若单独抽出本 skill，则在 skill 目录执行 `pnpm add qrcode`

## 凭证配置

脚本从 `.env` 读取认证信息，默认查找 skill 目录下的 `.env`，可用环境变量 `TML_ENV_FILE` 覆盖。创建 `skills/tml-qr/.env`（权限 600）：

```dotenv
TML_USER_ID=<userId>
TML_LOGIN_SESSION=<loginsession>
TML_GLOBAL_AREA_ID=1
TML_AREA_ID=1
TML_PARK_ID=1
```

`TML_LOGIN_SESSION` 是登录会话，过期后只需更新这一个值。凭证与生成的 PNG 都是敏感信息，不要提交进仓库。

## 步骤

1. 运行取码脚本：
   ```bash
   node skills/tml-qr/scripts/fetch-tml-qr.mjs
   ```
2. 成功时 stdout 是一行 JSON：
   ```json
   {"qrPath":"/abs/path/consume-qr.png","personalBalance":"12.00","bookkeepingBalance":"45.00"}
   ```
   两个余额字段都可能为 null（相应接口查询失败时降级）。
3. 把 `qrPath` 指向的图片发送给用户，各平台用各自的方式；飞书/Hermes 环境直接输出 `MEDIA:<qrPath>`。
4. 余额非 null 时，在文字里附带「个人充值：<personalBalance> 元」「记账充值：<bookkeepingBalance> 元」。
5. 脚本 exit 非 0 时，把 stderr 错误原样告诉用户，多数是凭证过期，更新 `TML_LOGIN_SESSION` 即可。

## 输出字段

- `qrPath`：生成的 600×600 PNG 绝对路径（默认 `skills/tml-qr/output/consume-qr.png`，用 `TML_QR_OUTPUT` 覆盖）
- `personalBalance`：个人充值余额（元）。来自 `queryBalance` 接口的 `totalBalance`，源单位是分、脚本已除以 100
- `bookkeepingBalance`：记账充值余额（元）。来自 `bookkeepingRechargebalanceBalance/paginQuery` 接口的 `consumptionBalance`，源单位即元