import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTmlBalanceRequestBody,
  buildTmlRequestBody,
  decodeTmlBalancePayload,
  decodeTmlPayload,
  formatHttpFailure,
  getQrTitle,
  parseBoolean,
  validateReceiveIdType,
} from "../src/lib.js";

test("decodes a direct TML JSON response", () => {
  assert.equal(decodeTmlPayload('{"code":200,"data":"qr-value"}'), "qr-value");
});

test("decodes a JSON-string-wrapped TML response", () => {
  const wrapped = JSON.stringify(JSON.stringify({ code: 0, data: "qr-value" }));
  assert.equal(decodeTmlPayload(wrapped), "qr-value");
});

test("does not expose a missing QR payload", () => {
  assert.throws(() => decodeTmlPayload('{"code":200}'), /data 字段/);
});

test("decodes the total balance from the TML balance response", () => {
  const wrapped = JSON.stringify(JSON.stringify({ consumptionBalance: "60.0" }));
  assert.equal(decodeTmlBalancePayload(wrapped), "60.0");
});

test("rejects a balance response without a numeric consumptionBalance", () => {
  assert.throws(
    () => decodeTmlBalancePayload("{}"),
    /consumptionBalance/,
  );
});

test("rejects unsupported Feishu receiver id types", () => {
  assert.throws(() => validateReceiveIdType("phone"), /不支持/);
});

test("builds the exact TML request body field names", () => {
  assert.deepEqual(buildTmlRequestBody({
    tmlUserId: "user",
    tmlLoginSession: "session",
    globalAreaId: 1,
    areaId: 2,
    parkId: 3,
  }), {
    userId: "user",
    loginsession: "session",
    globalAreaId: 1,
    areaId: 2,
    parkId: 3,
  });
});

test("builds the TML consumption balance request with staffId", () => {
  assert.deepEqual(buildTmlBalanceRequestBody({
    tmlUserId: "staff",
    tmlLoginSession: "session",
    globalAreaId: 1,
    areaId: 2,
    parkId: 3,
  }), {
    staffId: "staff",
    loginsession: "session",
    globalAreaId: 1,
    areaId: 2,
    parkId: 3,
  });
});

test("parses common boolean environment values", () => {
  assert.equal(parseBoolean("yes", "VALUE"), true);
  assert.equal(parseBoolean("0", "VALUE"), false);
});

test("formats safe Feishu HTTP diagnostics without dumping arbitrary bodies", () => {
  assert.equal(formatHttpFailure({
    label: "上传飞书二维码",
    status: 400,
    responseText: JSON.stringify({ code: 99991663, msg: "permission denied", data: "sensitive" }),
    logId: "log-id",
  }), "上传飞书二维码HTTP 400（code=99991663, msg=permission denied, logid=log-id）");

  assert.equal(formatHttpFailure({
    label: "TML 二维码接口",
    status: 500,
    responseText: "raw-sensitive-body",
    logId: null,
  }), "TML 二维码接口HTTP 500");
});

test("formats the QR title with the Asia/Shanghai calendar date", () => {
  assert.equal(
    getQrTitle(new Date("2026-08-17T16:30:00Z"), "123.45"),
    "【2026年8月18日】通明湖付款码 当前余额：123.45 元",
  );
  assert.equal(
    getQrTitle(new Date("2026-08-18T16:00:00Z"), "0"),
    "【2026年8月19日】通明湖付款码 当前余额：0 元",
  );
});
