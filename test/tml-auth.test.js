import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { API, extractCredentials, extractSmsId, sendCode, smsLogin } from "../src/tml-auth.mjs";

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startMockServer(handler) {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    let result;
    try {
      result = await handler(request, body);
    } catch (e) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: e.message }));
      return;
    }
    if (result.status) response.writeHead(result.status, { "content-type": "application/json" });
    else response.setHeader("content-type", "application/json");
    response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function withPatchedApi(url, fn) {
  const original = { sendSms: API.sendSms, smsLogin: API.smsLogin };
  if (url !== undefined) API.sendSms = url;
  if (url !== undefined) API.smsLogin = url;
  return Promise.resolve(fn()).finally(() => {
    API.sendSms = original.sendSms;
    API.smsLogin = original.smsLogin;
  });
}

test("sendCode posts smsType=8 and returns the parsed payload", async () => {
  const { server, baseUrl } = await startMockServer((request, body) => {
    assert.equal(request.url, "/portal/open/send/sms");
    assert.equal(request.method, "POST");
    const payload = JSON.parse(body.toString("utf8"));
    assert.equal(payload.phone, "13800000000");
    assert.equal(payload.smsType, 8);
    assert.equal(payload.globalAreaId, "1");
    assert.equal(payload.parkId, "1");
    return { body: JSON.stringify({ code: 0, data: { smsId: "sms-123" } }) };
  });
  try {
    await withPatchedApi(`${baseUrl}/portal/open/send/sms`, async () => {
      const payload = await sendCode("13800000000", 1, 1, 1);
      assert.equal(extractSmsId(payload), "sms-123");
    });
  } finally {
    server.close();
  }
});

test("extractSmsId tolerates multiple payload shapes", () => {
  assert.equal(extractSmsId({ data: { smsId: "a" } }), "a");
  assert.equal(extractSmsId({ data: { smsid: "b" } }), "b");
  assert.equal(extractSmsId({ smsId: "c" }), "c");
  assert.equal(extractSmsId({ data: { id: "d" } }), "d");
  assert.equal(extractSmsId({ code: 0, data: {} }), null);
  assert.equal(extractSmsId(null), null);
});

test("extractCredentials pulls userId and loginsession from nested userInfo", () => {
  const cred = extractCredentials({
    data: { userInfo: { id: "u-1" }, loginsession: "sess-1" },
  });
  assert.equal(cred.userId, "u-1");
  assert.equal(cred.loginsession, "sess-1");
});

test("extractCredentials reads flat userId/loginSession fields", () => {
  const cred = extractCredentials({ data: { userId: "u-2", loginSession: "sess-2" } });
  assert.equal(cred.userId, "u-2");
  assert.equal(cred.loginsession, "sess-2");
});

test("extractCredentials returns undefined fields for empty payloads", () => {
  assert.equal(extractCredentials({}).userId, undefined);
  assert.equal(extractCredentials({}).loginsession, undefined);
  assert.equal(extractCredentials(null).userId, undefined);
});

test("smsLogin posts the correct login body and returns parsed payload", async () => {
  const { server, baseUrl } = await startMockServer((request, body) => {
    assert.equal(request.url, "/portal/open/smsLogin");
    const payload = JSON.parse(body.toString("utf8"));
    assert.equal(payload.customId, "13800000000");
    assert.equal(payload.smsCode, "654321");
    assert.equal(payload.smsId, "sms-123");
    assert.equal(payload.smsType, 8);
    return { body: JSON.stringify(JSON.stringify({ code: 0, data: { userInfo: { id: "u-9" }, loginsession: "sess-9" } })) };
  });
  try {
    await withPatchedApi(`${baseUrl}/portal/open/smsLogin`, async () => {
      const payload = await smsLogin("13800000000", "654321", "sms-123", 1, 1, 1);
      const cred = extractCredentials(payload);
      assert.equal(cred.userId, "u-9");
      assert.equal(cred.loginsession, "sess-9");
    });
  } finally {
    server.close();
  }
});

test("sendCode surfaces HTTP failure with status and message", async () => {
  const { server, baseUrl } = await startMockServer(() => {
    return { status: 500, body: JSON.stringify({ message: "boom" }) };
  });
  try {
    await withPatchedApi(`${baseUrl}/portal/open/send/sms`, async () => {
      await assert.rejects(sendCode("13800000000", 1, 1, 1), /HTTP 500/);
    });
  } finally {
    server.close();
  }
});
