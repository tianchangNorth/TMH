import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeJob,
  enqueueJob,
  listPendingJobs,
  loadTriggerConfig,
  parseTriggerEvent,
} from "../src/feishu-trigger.js";

function baseConfig(overrides = {}) {
  return {
    feishuReceiveId: "ou-authorized",
    feishuReceiveIdType: "open_id",
    ...overrides,
  };
}

function groupMessage(overrides = {}) {
  return {
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou-authorized" },
    },
    message: {
      message_id: "om-message-1",
      chat_id: "oc-chat-1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 重发二维码" }),
      mentions: [{ key: "@_user_1", name: "QR Bot" }],
    },
    ...overrides,
  };
}

test("uses the configured receiver as the default trigger sender allowlist", () => {
  const config = loadTriggerConfig(baseConfig(), {});
  assert.deepEqual([...config.allowedSenderIds], ["ou-authorized"]);
  assert.equal(config.allowedChatIds.size, 0);
});

test("accepts an authorized group mention command", () => {
  const config = loadTriggerConfig(baseConfig(), {});
  const result = parseTriggerEvent(groupMessage(), config);

  assert.equal(result.accepted, true);
  assert.equal(result.job.id, "om-message-1");
  assert.equal(result.job.chatId, "oc-chat-1");
  assert.match(result.job.messageUuid, /^[0-9a-f-]{36}$/);
});

test("accepts a bare mention and rejects unrelated text", () => {
  const config = loadTriggerConfig(baseConfig(), {});
  const bare = groupMessage({
    message: {
      ...groupMessage().message,
      content: JSON.stringify({ text: "@_user_1" }),
    },
  });
  const unrelated = groupMessage({
    message: {
      ...groupMessage().message,
      content: JSON.stringify({ text: "@_user_1 今天天气如何" }),
    },
  });

  assert.equal(parseTriggerEvent(bare, config).accepted, true);
  assert.equal(parseTriggerEvent(unrelated, config).reason, "unsupported_command");
});

test("qr command with a phone suffix targets a specific account without changing default", () => {
  const config = loadTriggerConfig(baseConfig(), {});
  const msg = (text) => groupMessage({
    message: { ...groupMessage().message, content: JSON.stringify({ text }) },
  });

  const byPhone = parseTriggerEvent(msg("@_user_1 二维码 13800000000"), config);
  assert.equal(byPhone.accepted, true);
  assert.equal(byPhone.job.accountPhone, "13800000000");

  const resendByPhone = parseTriggerEvent(msg("@_user_1 重发二维码 13800000000"), config);
  assert.equal(resendByPhone.accepted, true);
  assert.equal(resendByPhone.job.accountPhone, "13800000000");

  // 不带手机号时 accountPhone 为 null（走默认账号）
  const plain = parseTriggerEvent(msg("@_user_1 二维码"), config);
  assert.equal(plain.accepted, true);
  assert.equal(plain.job.accountPhone, null);

  // 非手机号后缀不匹配，按未支持命令处理
  const bad = parseTriggerEvent(msg("@_user_1 二维码 小王"), config);
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, "unsupported_command");
});

test("rejects an unauthorized sender and a group message without a mention", () => {
  const config = loadTriggerConfig(baseConfig(), {});
  const unauthorized = groupMessage({
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou-other" },
    },
  });
  const noMention = groupMessage({
    message: {
      ...groupMessage().message,
      mentions: [],
      content: JSON.stringify({ text: "重发二维码" }),
    },
  });

  assert.equal(parseTriggerEvent(unauthorized, config).reason, "unauthorized");
  assert.equal(parseTriggerEvent(noMention, config).reason, "not_mentioned");
});

test("keeps a completion marker so repeated Feishu delivery is deduplicated", async (context) => {
  const queueDirectory = await mkdtemp(join(tmpdir(), "tml-trigger-test-"));
  context.after(() => rm(queueDirectory, { recursive: true, force: true }));
  const job = {
    id: "om-message-1",
    messageUuid: "75d9fffd-7398-48b5-8994-34c8a9088745",
    chatId: "oc-chat-1",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  const first = await enqueueJob(queueDirectory, job);
  assert.equal(first.enqueued, true);
  assert.equal((await listPendingJobs(queueDirectory)).length, 1);

  await completeJob(first.path);
  assert.equal((await listPendingJobs(queueDirectory)).length, 0);
  assert.equal((await enqueueJob(queueDirectory, job)).enqueued, false);
});
