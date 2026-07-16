import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";

import { startControlServer } from "../src/control-server.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 7).toString("base64url");
const APP_ORIGIN = "app://-";
const VALID_BODY = { revision: 3, persistenceEnabled: false };

function jsonText(value) {
  return JSON.stringify(value);
}

function responseJson(response) {
  return JSON.parse(response.text);
}

function request(server, options = {}) {
  const method = options.method ?? "POST";
  const path = options.path ?? "/v1/persistence";
  const origin = Object.hasOwn(options, "origin") ? options.origin : APP_ORIGIN;
  const token = Object.hasOwn(options, "token") ? options.token : CONTROL_TOKEN;
  const host = Object.hasOwn(options, "host")
    ? options.host
    : `${server.host}:${server.port}`;
  const contentType = Object.hasOwn(options, "contentType")
    ? options.contentType
    : "application/json";
  const rawBody = options.rawBody ?? jsonText(options.body ?? VALID_BODY);
  const includeContentLength = options.includeContentLength ?? !options.chunked;
  const headers = { ...(options.headers ?? {}) };

  if (host !== undefined) headers.Host = host;
  if (origin !== undefined) headers.Origin = origin;
  if (token !== undefined) headers["X-HeiGe-Control-Token"] = token;
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (includeContentLength) {
    headers["Content-Length"] = options.contentLength ?? Buffer.byteLength(rawBody);
  }
  if (options.chunked) headers["Transfer-Encoding"] = "chunked";

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: server.host,
        port: server.port,
        method,
        path,
        headers,
        agent: false,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.writeChunks) {
      for (const chunk of options.writeChunks) outgoing.write(chunk);
      outgoing.end();
    } else {
      outgoing.end(rawBody);
    }
  });
}

function preflight(server, options = {}) {
  const origin = options.origin ?? APP_ORIGIN;
  const host = options.host ?? `${server.host}:${server.port}`;
  const headers = {
    Host: host,
    Origin: origin,
    "Access-Control-Request-Method": options.requestMethod ?? "POST",
    "Access-Control-Request-Headers":
      options.requestHeaders ?? "Content-Type, X-HeiGe-Control-Token",
  };
  return request(server, {
    method: "OPTIONS",
    path: options.path ?? "/v1/persistence",
    origin,
    host,
    rawBody: "",
    includeContentLength: false,
    contentType: undefined,
    token: undefined,
    headers,
  });
}

async function startFixture(t, overrides = {}) {
  let state = overrides.state ?? {
    persistenceEnabled: true,
    revision: 3,
    internalPath: "/Users/private/state.json",
  };
  const calls = [];
  const readState = overrides.readState ?? (async () => structuredClone(state));
  const setPersistence = overrides.setPersistence ?? (async (input) => {
    calls.push(input);
    state = {
      persistenceEnabled: input.enabled,
      revision: input.expectedRevision + 1,
      internalPath: "/Users/private/state.json",
    };
    return structuredClone(state);
  });
  const server = await startControlServer({
    token: CONTROL_TOKEN,
    allowedOrigins: new Set([APP_ORIGIN]),
    readState,
    setPersistence,
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: overrides.maxBodyBytes ?? 1024,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1500,
    maxConnections: overrides.maxConnections ?? 8,
  });
  t.after(() => server.close());
  return { server, calls, getState: () => structuredClone(state) };
}

function backendError({ code, persistenceEnabled, revision }) {
  const error = new Error(
    `sensitive ${CONTROL_TOKEN} /Users/private/controller.mjs stack-marker`,
  );
  error.code = code;
  error.persistenceEnabled = persistenceEnabled;
  error.revision = revision;
  error.headers = { authorization: "header-secret" };
  error.env = { PRIVATE_VALUE: "environment-secret" };
  error.stack = `${error.stack}\nstack-marker`;
  return error;
}

function rawPartialRequest(server, { declaredLength, partialBody = "" }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(chunks.join("")));
    socket.on("connect", () => {
      const lines = [
        "POST /v1/persistence HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        `Origin: ${APP_ORIGIN}`,
        "Content-Type: application/json",
        `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
        "Connection: close",
      ];
      if (declaredLength !== undefined) {
        lines.splice(4, 0, `Content-Length: ${declaredLength}`);
      }
      socket.write([...lines, "", partialBody].join("\r\n"));
    });
  });
}

function rawSlowHeaderRequest(server) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    const safetyTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("HEADER_TIMEOUT_NOT_ENFORCED"));
    }, 250);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      clearTimeout(safetyTimeout);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(safetyTimeout);
      resolve(chunks.join(""));
    });
    socket.on("connect", () => {
      socket.write("POST /v1/persistence HTTP/1.1\r\nHost:");
    });
  });
}

function rawKeepAliveRequest(server) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    const safetyTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("IDLE_CONNECTION_TIMEOUT_NOT_ENFORCED"));
    }, 250);
    let unexpectedError;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") unexpectedError = error;
    });
    socket.on("close", () => {
      clearTimeout(safetyTimeout);
      if (unexpectedError) reject(unexpectedError);
      else resolve(chunks.join(""));
    });
    socket.on("connect", () => {
      const body = jsonText(VALID_BODY);
      socket.write(
        [
          "POST /v1/persistence HTTP/1.1",
          `Host: ${server.host}:${server.port}`,
          `Origin: ${APP_ORIGIN}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
          "Connection: keep-alive",
          "",
          body,
        ].join("\r\n"),
      );
    });
  });
}

test("refuses any bind host other than IPv4 loopback", async () => {
  await assert.rejects(
    startControlServer({
      token: CONTROL_TOKEN,
      allowedOrigins: new Set([APP_ORIGIN]),
      readState: async () => ({ persistenceEnabled: true, revision: 3 }),
      setPersistence: async () => ({ persistenceEnabled: false, revision: 4 }),
      host: "0.0.0.0",
      port: 0,
    }),
    /只能绑定 127\.0\.0\.1/,
  );
});

test("requires a canonical 32-byte base64url control token", async () => {
  const invalidTokens = [
    "short",
    Buffer.alloc(31, 1).toString("base64url"),
    `${CONTROL_TOKEN}=`,
    `${CONTROL_TOKEN.slice(0, -1)}+`,
  ];

  for (const token of invalidTokens) {
    let started;
    try {
      started = await startControlServer({
        token,
        allowedOrigins: new Set([APP_ORIGIN]),
        readState: async () => ({ persistenceEnabled: true, revision: 3 }),
        setPersistence: async () => ({ persistenceEnabled: false, revision: 4 }),
        host: "127.0.0.1",
        port: 0,
      });
    } catch (error) {
      assert.match(error.message, /32 字节.*base64url/);
      continue;
    }
    await started.close();
    assert.fail("accepted a noncanonical control token");
  }
});

test("binds only IPv4 loopback and accepts the exact persistence request", async (t) => {
  const { server, calls } = await startFixture(t);
  assert.equal(server.host, "127.0.0.1");
  assert.ok(Number.isInteger(server.port) && server.port > 0);

  const response = await request(server, { body: VALID_BODY });

  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { expectedRevision: calls[0].expectedRevision, enabled: calls[0].enabled },
    { expectedRevision: 3, enabled: false },
  );
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("answers only the exact CORS persistence preflight", async (t) => {
  const { server } = await startFixture(t);

  const accepted = await preflight(server);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.text, "");
  assert.equal(accepted.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.equal(accepted.headers["access-control-allow-methods"], "POST");
  assert.equal(
    accepted.headers["access-control-allow-headers"],
    "Content-Type, X-HeiGe-Control-Token",
  );

  assert.equal((await preflight(server, { requestMethod: "PUT" })).status, 400);
  assert.equal(
    (await preflight(server, {
      requestHeaders: "Content-Type, X-HeiGe-Control-Token, X-Extra",
    })).status,
    400,
  );
  const hostile = await preflight(server, { origin: "https://evil.example" });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers["access-control-allow-origin"], undefined);
});

test("rejects hostile and opaque origins without reflecting them", async (t) => {
  const { server } = await startFixture(t);

  for (const origin of ["https://evil.example", "null"]) {
    const response = await request(server, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(Object.keys(responseJson(response)).sort(), ["code", "message", "ok"]);
  }
});

test("rejects the wrong control token without echoing it", async (t) => {
  const { server } = await startFixture(t);
  const wrongToken = "wrong-token-secret";

  const response = await request(server, { token: wrongToken });

  assert.equal(response.status, 401);
  assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.equal(response.text.includes(wrongToken), false);
  assert.deepEqual(Object.keys(responseJson(response)).sort(), ["code", "message", "ok"]);
});

test("requires the exact loopback Host header", async (t) => {
  const { server } = await startFixture(t);

  const response = await request(server, { host: "evil.example" });

  assert.equal(response.status, 400);
  assert.equal(response.text.includes("evil.example"), false);
});

test("rejects every method and path outside the two-route surface", async (t) => {
  const { server } = await startFixture(t);

  assert.equal((await request(server, { method: "GET" })).status, 405);
  assert.equal((await request(server, { method: "PUT" })).status, 405);
  assert.equal((await request(server, { path: "/v1/persistence?secret=path-secret" })).status, 404);
  assert.equal((await preflight(server, { path: "/v1/other" })).status, 404);
});

test("requires exact JSON content type and a declared nonempty length", async (t) => {
  const { server } = await startFixture(t);

  assert.equal(
    (await request(server, { contentType: "application/json; charset=utf-8" })).status,
    415,
  );
  const noLength = await rawPartialRequest(server, {});
  assert.match(noLength, /^HTTP\/1\.1 411 /);
  assert.equal(
    (await request(server, {
      rawBody: "",
      includeContentLength: true,
      contentLength: 0,
    })).status,
    400,
  );
  assert.equal(
    (await request(server, {
      chunked: true,
      writeChunks: [jsonText(VALID_BODY)],
    })).status,
    400,
  );
});

test("rejects a declared request body above the byte cap", async (t) => {
  const { server } = await startFixture(t);

  const response = await request(server, { rawBody: "x".repeat(1025) });

  assert.equal(response.status, 413);
  assert.equal(response.text.includes("x".repeat(32)), false);
});

test("accepts only a plain JSON object with exactly the two protocol keys", async (t) => {
  const { server } = await startFixture(t);

  assert.equal(
    (await request(server, {
      body: { revision: 3, persistenceEnabled: false, command: "open" },
    })).status,
    400,
  );
  assert.equal((await request(server, { rawBody: "[3,false]" })).status, 400);
  assert.equal((await request(server, { rawBody: "null" })).status, 400);
  assert.equal((await request(server, { rawBody: "{not-json" })).status, 400);
});

test("rejects noninteger and negative revisions and nonboolean values", async (t) => {
  const { server } = await startFixture(t);

  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    assert.equal(
      (await request(server, { body: { revision, persistenceEnabled: false } })).status,
      400,
    );
  }
  for (const persistenceEnabled of [0, "false", null]) {
    assert.equal(
      (await request(server, { body: { revision: 3, persistenceEnabled } })).status,
      400,
    );
  }
});

test("returns the authoritative state for a stale same-value retry", async (t) => {
  let calls = 0;
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 9 },
    setPersistence: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 9,
  });
  assert.equal(calls, 0);
});

test("rejects a backend success that skips the next revision", async (t) => {
  const { server } = await startFixture(t, {
    setPersistence: async () => ({ persistenceEnabled: false, revision: 5 }),
  });

  const response = await request(server);

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
});

test("returns a safe conflict for a stale different-value request", async (t) => {
  let calls = 0;
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: true, revision: 9 },
    setPersistence: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: false },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "REVISION_CONFLICT",
    message: "状态已发生变化，请重试",
    persistenceEnabled: true,
    revision: 9,
  });
  assert.equal(calls, 0);
});

test("a compensated backend failure returns safe authoritative state", async (t) => {
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw backendError({
        code: "BACKGROUND_START_FAILED",
        persistenceEnabled: false,
        revision: 5,
      });
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "BACKGROUND_START_FAILED",
    message: "后台控制器启动失败，常驻仍为关闭",
    persistenceEnabled: false,
    revision: 5,
  });
});

test("redacts token path headers environment and stack from backend errors", async (t) => {
  const { server } = await startFixture(t, {
    setPersistence: async () => {
      throw backendError({
        code: `LEAK_${CONTROL_TOKEN}`,
        persistenceEnabled: undefined,
        revision: undefined,
      });
    },
  });

  const response = await request(server);
  const body = responseJson(response);

  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
  for (const secret of [
    CONTROL_TOKEN,
    "/Users/private/controller.mjs",
    "header-secret",
    "environment-secret",
    "stack-marker",
  ]) {
    assert.equal(response.text.includes(secret), false);
  }
});

test("times out an incomplete request body", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawPartialRequest(server, {
    declaredLength: 64,
    partialBody: '{"revision":3',
  });

  assert.match(rawResponse, /^HTTP\/1\.1 408 /);
  assert.equal(rawResponse.includes(CONTROL_TOKEN), false);
  assert.match(rawResponse, /"code":"REQUEST_TIMEOUT"/);
});

test("times out a connection that never completes request headers", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawSlowHeaderRequest(server);

  assert.match(rawResponse, /^HTTP\/1\.1 408 /);
  assert.match(rawResponse, /"code":"REQUEST_TIMEOUT"/);
  assert.equal(rawResponse.includes(CONTROL_TOKEN), false);
});

test("closes an idle keep-alive socket without an unsolicited response", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawKeepAliveRequest(server);

  assert.equal(rawResponse.match(/HTTP\/1\.1/g)?.length, 1);
  assert.match(rawResponse, /^HTTP\/1\.1 200 /);
  assert.equal(rawResponse.includes("REQUEST_TIMEOUT"), false);
});

test("times out a backend handler that does not settle", async (t) => {
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    setPersistence: async () => new Promise(() => {}),
  });

  const response = await request(server);

  assert.equal(response.status, 408);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "REQUEST_TIMEOUT",
    message: "请求超时，请重试",
  });
});

test("aborts an in-flight persistence operation at the request deadline", async (t) => {
  let receivedSignal;
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    setPersistence: async (input) => {
      receivedSignal = input.signal;
      return new Promise((resolve, reject) => {
        if (input.signal?.aborted) {
          reject(input.signal.reason);
          return;
        }
        input.signal?.addEventListener(
          "abort",
          () => reject(input.signal.reason),
          { once: true },
        );
      });
    },
  });

  const response = await request(server);

  assert.equal(response.status, 408);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, true);
});

test("does not start a persistence write after the request deadline", async (t) => {
  let releaseReadState;
  let writes = 0;
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    readState: async () => new Promise((resolve) => {
      releaseReadState = resolve;
    }),
    setPersistence: async () => {
      writes += 1;
      return { persistenceEnabled: false, revision: 4 };
    },
  });

  const response = await request(server);
  assert.equal(response.status, 408);
  assert.equal(typeof releaseReadState, "function");

  releaseReadState({ persistenceEnabled: true, revision: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("caps simultaneous connections", async (t) => {
  const { server } = await startFixture(t, { maxConnections: 1 });
  const held = net.createConnection({ host: server.host, port: server.port });
  t.after(() => held.destroy());
  await once(held, "connect");

  let timeoutId;
  try {
    await assert.rejects(Promise.race([
      request(server),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("MAX_CONNECTIONS_NOT_ENFORCED")),
          500,
        );
      }),
    ]), (error) => error.message !== "MAX_CONNECTIONS_NOT_ENFORCED");
  } finally {
    clearTimeout(timeoutId);
  }
});

test("shutdown is idempotent and stops accepting connections", async (t) => {
  const { server } = await startFixture(t);

  await Promise.all([server.close(), server.close()]);
  await server.close();

  await assert.rejects(request(server));
});
