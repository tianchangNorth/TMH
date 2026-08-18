import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getQrTitle } from "../src/lib.js";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("runs the complete TML to Feishu image pipeline against local APIs", async (context) => {
  const calls = [];
  const expectedTitle = getQrTitle(new Date(), "123.45");
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    calls.push({ url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");

    if (request.url === "/tml") {
      const payload = JSON.parse(body.toString("utf8"));
      assert.deepEqual(payload, {
        userId: "test-user",
        loginsession: "test-session",
        globalAreaId: 1,
        areaId: 1,
        parkId: 1,
      });
      assert.equal(request.headers.loginsession, "test-session");
      assert.equal(request.headers.cookie, "loginsession=test-session");
      response.end(JSON.stringify(JSON.stringify({ code: 200, data: "test-qr-payload" })));
      return;
    }

    if (request.url === "/balance") {
      const payload = JSON.parse(body.toString("utf8"));
      assert.deepEqual(payload, {
        loginsession: "test-session",
        globalAreaId: 1,
        areaId: 1,
        parkId: 1,
      });
      assert.equal(request.headers.loginsession, "test-session");
      assert.equal(request.headers.cookie, "loginsession=test-session");
      response.end(JSON.stringify({
        code: "200",
        message: "操作成功",
        body: { totalBalance: "123.45" },
        success: true,
      }));
      return;
    }

    if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
      assert.deepEqual(JSON.parse(body.toString("utf8")), {
        app_id: "test-app-id",
        app_secret: "test-app-secret",
      });
      response.end(JSON.stringify({ code: 0, tenant_access_token: "test-token" }));
      return;
    }

    if (request.url === "/open-apis/im/v1/images") {
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
      assert.ok(body.includes(Buffer.from("image_type")));
      assert.ok(body.includes(Buffer.from("consume-qr.png")));
      assert.ok(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
      response.end(JSON.stringify({ code: 0, data: { image_key: "test-image-key" } }));
      return;
    }

    if (request.url?.startsWith("/open-apis/im/v1/messages?")) {
      assert.equal(request.headers.authorization, "Bearer test-token");
      const payload = JSON.parse(body.toString("utf8"));
      assert.equal(payload.receive_id, "test-open-id");
      assert.equal(payload.msg_type, "post");
      assert.deepEqual(JSON.parse(payload.content), {
        zh_cn: {
          title: expectedTitle,
          content: [[{ tag: "img", image_key: "test-image-key" }]],
        },
      });
      assert.match(payload.uuid, /^[0-9a-f-]{36}$/);
      response.end(JSON.stringify({ code: 0, data: { message_id: "test-message" } }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404, msg: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/send-qr.js"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      TML_API_URL: `${baseUrl}/tml`,
      TML_BALANCE_API_URL: `${baseUrl}/balance`,
      TML_USER_ID: "test-user",
      TML_LOGIN_SESSION: "test-session",
      FEISHU_API_BASE: `${baseUrl}/open-apis`,
      FEISHU_APP_ID: "test-app-id",
      FEISHU_APP_SECRET: "test-app-secret",
      FEISHU_RECEIVE_ID: "test-open-id",
      FEISHU_RECEIVE_ID_TYPE: "open_id",
      FEISHU_FAILURE_NOTIFICATION: "false",
      KEEP_QR: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /通明湖付款码已发送到飞书/);
  assert.doesNotMatch(stdout, /123\.45/);
  assert.equal(calls.length, 5);
});
