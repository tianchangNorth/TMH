const TML_SUCCESS_CODES = new Set([0, 200, "0", "200"]);

export function decodeTmlPayload(rawText) {
  let payload;

  try {
    payload = JSON.parse(rawText);
    if (typeof payload === "string") {
      payload = JSON.parse(payload);
    }
  } catch {
    throw new Error("TML 接口返回的不是有效 JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("TML 接口返回结构异常");
  }

  if (payload.code !== undefined && !TML_SUCCESS_CODES.has(payload.code)) {
    const message = typeof payload.message === "string"
      ? payload.message
      : typeof payload.msg === "string"
        ? payload.msg
        : "未知业务错误";
    throw new Error(`TML 接口业务失败：${message}`);
  }

  if (typeof payload.data !== "string" || payload.data.length === 0) {
    throw new Error("TML 接口未返回可生成二维码的 data 字段");
  }

  return payload.data;
}

export function parsePositiveInteger(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return Number(value);
}

export function parseBoolean(value, name) {
  if (typeof value === "boolean") return value;
  if (/^(true|1|yes)$/i.test(String(value))) return true;
  if (/^(false|0|no)$/i.test(String(value))) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

export function requireEnvironment(environment, names) {
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`缺少必填环境变量：${missing.join(", ")}`);
  }
}

export function validateReceiveIdType(value) {
  const allowed = new Set(["open_id", "user_id", "union_id", "email", "chat_id"]);
  if (!allowed.has(value)) {
    throw new Error(`FEISHU_RECEIVE_ID_TYPE 不支持：${value}`);
  }
  return value;
}

export function buildTmlRequestBody(config) {
  return {
    userId: config.tmlUserId,
    loginsession: config.tmlLoginSession,
    globalAreaId: config.globalAreaId,
    areaId: config.areaId,
    parkId: config.parkId,
  };
}

export function formatHttpFailure({ label, status, responseText, logId }) {
  const details = [];

  try {
    let payload = JSON.parse(responseText);
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (payload && typeof payload === "object") {
      if (payload.code !== undefined) details.push(`code=${payload.code}`);
      const message = typeof payload.msg === "string"
        ? payload.msg
        : typeof payload.message === "string"
          ? payload.message
          : null;
      if (message) details.push(`msg=${message}`);
    }
  } catch {
    // Do not include arbitrary response text: it may contain QR or credential data.
  }

  if (logId) details.push(`logid=${logId}`);
  const suffix = details.length > 0 ? `（${details.join(", ")}）` : "";
  return `${label}HTTP ${status}${suffix}`;
}
