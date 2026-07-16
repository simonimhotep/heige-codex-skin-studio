import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const CONTROL_PATH = "/v1/persistence";
const AUDITED_ORIGIN = "app://-";
const PREFLIGHT_METHOD = "POST";
const PREFLIGHT_HEADERS = ["content-type", "x-heige-control-token"];
const RESPONSE_PREFLIGHT_HEADERS = "Content-Type, X-HeiGe-Control-Token";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const SAFE_ERRORS = Object.freeze({
  NOT_FOUND: { status: 404, message: "控制接口不存在" },
  METHOD_NOT_ALLOWED: { status: 405, message: "请求方法不受支持" },
  INVALID_HOST: { status: 400, message: "请求主机无效" },
  ORIGIN_FORBIDDEN: { status: 403, message: "请求来源不受信任" },
  INVALID_PREFLIGHT: { status: 400, message: "预检请求无效" },
  UNAUTHORIZED: { status: 401, message: "控制凭证无效" },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "请求必须使用 application/json",
  },
  TRANSFER_ENCODING_FORBIDDEN: { status: 400, message: "不接受分块请求" },
  LENGTH_REQUIRED: { status: 411, message: "请求必须声明 Content-Length" },
  INVALID_CONTENT_LENGTH: { status: 400, message: "Content-Length 无效" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "请求体过大" },
  INVALID_JSON: { status: 400, message: "请求 JSON 无效" },
  INVALID_REQUEST: { status: 400, message: "请求参数无效" },
  REVISION_CONFLICT: { status: 409, message: "状态已发生变化，请重试" },
  REQUEST_TIMEOUT: { status: 408, message: "请求超时，请重试" },
  CONTROL_UNAVAILABLE: { status: 503, message: "控制服务暂时不可用，请重试" },
  PERSISTENCE_UPDATE_FAILED: { status: 503, message: "常驻设置失败，请重试" },
  BACKGROUND_START_FAILED: {
    status: 503,
    message: "后台控制器启动失败，常驻仍为关闭",
  },
});

class ProtocolError extends Error {
  constructor(code, state = undefined) {
    super(code);
    this.name = "ProtocolError";
    this.code = code;
    this.state = state;
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("request timed out");
    this.name = "RequestTimeoutError";
  }
}

function protocolError(code, state) {
  return new ProtocolError(code, state);
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (
    allowedOrigins === null ||
    allowedOrigins === undefined ||
    typeof allowedOrigins === "string" ||
    typeof allowedOrigins[Symbol.iterator] !== "function"
  ) {
    throw new Error("allowedOrigins 必须是来源集合");
  }
  const origins = new Set(allowedOrigins);
  if ([...origins].some((origin) => typeof origin !== "string")) {
    throw new Error("allowedOrigins 只能包含字符串");
  }
  if (!origins.has(AUDITED_ORIGIN)) {
    throw new Error("allowedOrigins 必须包含 app://-");
  }
  return origins;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} 必须是函数`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function requirePort(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("port 必须是 0 到 65535 之间的整数");
  }
  return value;
}

function requireControlToken(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("token 必须是 32 字节无填充 canonical base64url");
  }
  return value;
}

function singleHeader(request, name) {
  const lowerName = name.toLowerCase();
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === lowerName) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return {
    count: values.length,
    value: values.length === 1 ? values[0] : undefined,
  };
}

function isAllowedOrigin(originHeader, allowedOrigins) {
  return (
    originHeader.count === 1 &&
    originHeader.value === AUDITED_ORIGIN &&
    allowedOrigins.has(originHeader.value)
  );
}

function exactTokenMatches(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function extractState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.persistenceEnabled !== "boolean" ||
    !isNonNegativeInteger(value.revision)
  ) {
    return null;
  }
  return {
    persistenceEnabled: value.persistenceEnabled,
    revision: value.revision,
  };
}

function extractErrorState(error) {
  if (error === null || typeof error !== "object") return null;
  try {
    return extractState(error.state) ?? extractState(error);
  } catch {
    return null;
  }
}

function exactRequestBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "persistenceEnabled" ||
    keys[1] !== "revision" ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.persistenceEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    revision: value.revision,
    persistenceEnabled: value.persistenceEnabled,
  };
}

function safeBody(code, state = undefined) {
  const definition = SAFE_ERRORS[code] ?? SAFE_ERRORS.CONTROL_UNAVAILABLE;
  const body = {
    ok: false,
    code: SAFE_ERRORS[code] === undefined ? "CONTROL_UNAVAILABLE" : code,
    message: definition.message,
  };
  const safeState = extractState(state);
  if (safeState !== null) {
    body.persistenceEnabled = safeState.persistenceEnabled;
    body.revision = safeState.revision;
  }
  return { status: definition.status, body };
}

function okBody(state) {
  return {
    status: 200,
    body: {
      ok: true,
      persistenceEnabled: state.persistenceEnabled,
      revision: state.revision,
    },
  };
}

function readBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxBodyBytes) {
        settle(reject, protocolError("PAYLOAD_TOO_LARGE"));
        request.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks, totalBytes));
    const onAborted = () => settle(reject, protocolError("INVALID_REQUEST"));
    const onError = () => settle(reject, protocolError("INVALID_REQUEST"));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
  });
}

function validatePreflight(request) {
  const method = singleHeader(request, "access-control-request-method");
  const requestedHeaders = singleHeader(request, "access-control-request-headers");
  if (method.count !== 1 || method.value !== PREFLIGHT_METHOD) {
    throw protocolError("INVALID_PREFLIGHT");
  }
  if (requestedHeaders.count !== 1) throw protocolError("INVALID_PREFLIGHT");
  const normalized = requestedHeaders.value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .sort();
  if (
    normalized.length !== PREFLIGHT_HEADERS.length ||
    normalized.some((header, index) => header !== PREFLIGHT_HEADERS[index])
  ) {
    throw protocolError("INVALID_PREFLIGHT");
  }
}

function parseContentLength(request, maxBodyBytes) {
  const transferEncoding = singleHeader(request, "transfer-encoding");
  if (transferEncoding.count !== 0) {
    throw protocolError("TRANSFER_ENCODING_FORBIDDEN");
  }

  const contentLength = singleHeader(request, "content-length");
  if (contentLength.count === 0) throw protocolError("LENGTH_REQUIRED");
  if (contentLength.count !== 1 || !/^[0-9]+$/.test(contentLength.value)) {
    throw protocolError("INVALID_CONTENT_LENGTH");
  }
  const length = Number(contentLength.value);
  if (!Number.isSafeInteger(length) || length === 0) {
    throw protocolError("INVALID_CONTENT_LENGTH");
  }
  if (length > maxBodyBytes) throw protocolError("PAYLOAD_TOO_LARGE");
  return length;
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof RequestTimeoutError) throw signal.reason;
  throw new RequestTimeoutError();
}

async function routePersistenceRequest(request, context, signal) {
  if (request.url !== CONTROL_PATH) throw protocolError("NOT_FOUND");
  if (request.method !== "POST" && request.method !== "OPTIONS") {
    throw protocolError("METHOD_NOT_ALLOWED");
  }

  const host = singleHeader(request, "host");
  if (host.count !== 1 || host.value !== context.expectedHost) {
    throw protocolError("INVALID_HOST");
  }

  const origin = singleHeader(request, "origin");
  if (!isAllowedOrigin(origin, context.allowedOrigins)) {
    throw protocolError("ORIGIN_FORBIDDEN");
  }

  if (request.method === "OPTIONS") {
    validatePreflight(request);
    return { status: 204, body: null, preflight: true };
  }

  const suppliedToken = singleHeader(request, "x-heige-control-token");
  if (
    suppliedToken.count !== 1 ||
    !exactTokenMatches(suppliedToken.value, context.token)
  ) {
    throw protocolError("UNAUTHORIZED");
  }

  const contentType = singleHeader(request, "content-type");
  if (contentType.count !== 1 || contentType.value !== "application/json") {
    throw protocolError("UNSUPPORTED_MEDIA_TYPE");
  }

  const declaredLength = parseContentLength(request, context.maxBodyBytes);
  const bytes = await readBody(request, context.maxBodyBytes);
  throwIfAborted(signal);
  if (bytes.length !== declaredLength) throw protocolError("INVALID_CONTENT_LENGTH");

  let parsed;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    throw protocolError("INVALID_JSON");
  }
  const input = exactRequestBody(parsed);
  if (input === null) throw protocolError("INVALID_REQUEST");

  let current;
  try {
    current = extractState(await context.readState());
  } catch {
    throwIfAborted(signal);
    throw protocolError("CONTROL_UNAVAILABLE");
  }
  throwIfAborted(signal);
  if (current === null) throw protocolError("CONTROL_UNAVAILABLE");

  if (current.persistenceEnabled === input.persistenceEnabled) {
    return okBody(current);
  }
  if (current.revision !== input.revision) {
    throw protocolError("REVISION_CONFLICT", current);
  }

  let updated;
  try {
    updated = extractState(await context.setPersistence({
      expectedRevision: input.revision,
      enabled: input.persistenceEnabled,
      signal,
    }));
  } catch (error) {
    throwIfAborted(signal);
    const authoritativeState = extractErrorState(error);
    let code;
    try {
      code = error?.code;
    } catch {
      code = undefined;
    }
    if (code === "REVISION_CONFLICT") {
      throw protocolError("REVISION_CONFLICT", authoritativeState ?? undefined);
    }
    if (code === "BACKGROUND_START_FAILED") {
      throw protocolError("BACKGROUND_START_FAILED", authoritativeState ?? undefined);
    }
    throw protocolError("PERSISTENCE_UPDATE_FAILED");
  }
  throwIfAborted(signal);

  if (
    updated === null ||
    updated.persistenceEnabled !== input.persistenceEnabled ||
    updated.revision !== current.revision + 1
  ) {
    throw protocolError("PERSISTENCE_UPDATE_FAILED");
  }
  return okBody(updated);
}

function sendResponse(response, descriptor, corsOrigin, request) {
  if (response.destroyed || response.writableEnded) return;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (corsOrigin !== undefined) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers.Vary = "Origin";
  }
  if (descriptor.preflight) {
    headers["Access-Control-Allow-Methods"] = PREFLIGHT_METHOD;
    headers["Access-Control-Allow-Headers"] = RESPONSE_PREFLIGHT_HEADERS;
    response.writeHead(204, headers);
    response.end();
    return;
  }

  const payload = JSON.stringify(descriptor.body);
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = Buffer.byteLength(payload);
  if (descriptor.closeConnection) headers.Connection = "close";
  response.writeHead(descriptor.status, headers);
  response.end(payload);
  if (descriptor.closeConnection) {
    response.once("finish", () => request.destroy());
  }
}

function requestHandler(context) {
  return async (request, response) => {
    const origin = singleHeader(request, "origin");
    const corsOrigin = isAllowedOrigin(origin, context.allowedOrigins)
      ? origin.value
      : undefined;
    let timeoutId;
    const abortController = new AbortController();
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new RequestTimeoutError();
        reject(error);
        abortController.abort(error);
      }, context.requestTimeoutMs);
      timeoutId.unref?.();
    });

    try {
      const descriptor = await Promise.race([
        routePersistenceRequest(request, context, abortController.signal),
        timeout,
      ]);
      sendResponse(response, descriptor, corsOrigin, request);
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        sendResponse(
          response,
          { ...safeBody("REQUEST_TIMEOUT"), closeConnection: true },
          corsOrigin,
          request,
        );
      } else if (error instanceof ProtocolError) {
        sendResponse(response, safeBody(error.code, error.state), corsOrigin, request);
      } else {
        sendResponse(response, safeBody("CONTROL_UNAVAILABLE"), corsOrigin, request);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

function sendSocketError(socket, { status, statusText, code, message }) {
  if (!socket.writable) return;
  const payload = JSON.stringify({ ok: false, code, message });
  socket.end(
    [
      `HTTP/1.1 ${status} ${statusText}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "Cache-Control: no-store",
      "X-Content-Type-Options: nosniff",
      "Connection: close",
      "",
      payload,
    ].join("\r\n"),
    () => socket.destroy(),
  );
}

function sendParserError(socket) {
  sendSocketError(socket, {
    status: 400,
    statusText: "Bad Request",
    code: "INVALID_REQUEST",
    message: SAFE_ERRORS.INVALID_REQUEST.message,
  });
}

function sendHeaderTimeout(socket) {
  sendSocketError(socket, {
    status: 408,
    statusText: "Request Timeout",
    code: "REQUEST_TIMEOUT",
    message: SAFE_ERRORS.REQUEST_TIMEOUT.message,
  });
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function createIdempotentClose(server, sockets) {
  let closePromise;
  return () => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
}

function installConnectionDeadlines(server, requestTimeoutMs, sockets) {
  const connectionState = new Map();

  const clearDeadline = (state) => {
    clearTimeout(state.headerDeadline);
    state.headerDeadline = undefined;
  };
  const armDeadline = (socket, state) => {
    clearDeadline(state);
    state.headerBytesSeen = false;
    state.headerDeadline = setTimeout(() => {
      state.headerDeadline = undefined;
      if (state.headerBytesSeen) sendHeaderTimeout(socket);
      else socket.destroy();
    }, requestTimeoutMs);
    state.headerDeadline.unref?.();
  };

  server.on("connection", (socket) => {
    const state = {
      activeRequests: 0,
      headerBytesSeen: false,
      headerDeadline: undefined,
    };
    connectionState.set(socket, state);
    sockets.add(socket);
    armDeadline(socket, state);
    socket.on("data", () => {
      if (state.activeRequests === 0) state.headerBytesSeen = true;
    });
    socket.once("close", () => {
      clearDeadline(state);
      connectionState.delete(socket);
      sockets.delete(socket);
    });
  });

  return (request, response) => {
    const state = connectionState.get(request.socket);
    if (state === undefined) return;
    clearDeadline(state);
    state.activeRequests += 1;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      state.activeRequests -= 1;
      if (state.activeRequests === 0 && !request.socket.destroyed) {
        armDeadline(request.socket, state);
      }
    };
    response.once("finish", complete);
    response.once("close", complete);
  };
}

export async function startControlServer({
  token,
  allowedOrigins,
  readState,
  setPersistence,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = 1024,
  requestTimeoutMs = 1500,
  maxConnections = 8,
}) {
  if (host !== "127.0.0.1") throw new Error("控制通道只能绑定 127.0.0.1");
  const safeToken = requireControlToken(token);
  const origins = normalizeAllowedOrigins(allowedOrigins);
  const safeReadState = requireFunction(readState, "readState");
  const safeSetPersistence = requireFunction(setPersistence, "setPersistence");
  const safePort = requirePort(port);
  const bodyLimit = requirePositiveInteger(maxBodyBytes, "maxBodyBytes");
  const timeoutMs = requirePositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  const connectionLimit = requirePositiveInteger(maxConnections, "maxConnections");

  const context = {
    token: safeToken,
    allowedOrigins: origins,
    readState: safeReadState,
    setPersistence: safeSetPersistence,
    maxBodyBytes: bodyLimit,
    requestTimeoutMs: timeoutMs,
    expectedHost: undefined,
  };
  const sockets = new Set();
  const handleRequest = requestHandler(context);
  let markRequestStarted = () => {};
  const server = createServer((request, response) => {
    markRequestStarted(request, response);
    void handleRequest(request, response);
  });
  server.maxConnections = connectionLimit;
  server.keepAliveTimeout = timeoutMs;
  markRequestStarted = installConnectionDeadlines(server, timeoutMs, sockets);
  server.on("clientError", (_error, socket) => sendParserError(socket));

  try {
    await listen(server, { host, port: safePort });
  } catch (error) {
    server.closeAllConnections?.();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("控制通道监听地址无效");
  }
  context.expectedHost = `${host}:${address.port}`;

  return {
    host,
    port: address.port,
    close: createIdempotentClose(server, sockets),
  };
}
