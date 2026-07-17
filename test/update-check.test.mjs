import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLatestRelease,
  compareStableVersions,
  createCachedUpdateChecker,
  parseStableVersion,
  readCurrentPackageVersion,
} from "../src/update-check.mjs";

const RELEASE_URL =
  "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.3.0";

function release(overrides = {}) {
  return {
    tag_name: "v5.3.0",
    html_url: RELEASE_URL,
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

test("parses only canonical stable three-part versions", () => {
  assert.deepEqual(parseStableVersion("5.2.2"), [5, 2, 2]);
  for (const value of [
    "v5.2.2",
    "5.2",
    "05.2.2",
    "5.02.2",
    "5.2.02",
    "5.2.2-beta.1",
    "5.2.2.0",
    `${Number.MAX_SAFE_INTEGER + 1}.0.0`,
  ]) {
    assert.throws(() => parseStableVersion(value), /stable version/i);
  }
});

test("compares stable versions numerically", () => {
  assert.equal(compareStableVersions("5.2.2", "5.2.2"), 0);
  assert.equal(compareStableVersions("5.2.2", "5.3.0"), -1);
  assert.equal(compareStableVersions("6.0.0", "5.9.9"), 1);
  assert.equal(compareStableVersions("5.10.0", "5.9.9"), 1);
});

test("reads the installed package version from strict bounded JSON", async () => {
  assert.equal(
    await readCurrentPackageVersion({
      readFileImpl: async () =>
        JSON.stringify({
          name: "heige-codex-skin-studio",
          version: "5.2.2",
        }),
    }),
    "5.2.2",
  );

  await assert.rejects(
    readCurrentPackageVersion({
      readFileImpl: async () =>
        JSON.stringify({ name: "foreign-package", version: "5.2.2" }),
    }),
    /package identity/i,
  );
  await assert.rejects(
    readCurrentPackageVersion({
      readFileImpl: async () => "x".repeat(64 * 1024 + 1),
    }),
    /too large/i,
  );
});

test("accepts only the latest stable release for the exact repository", async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const result = await checkLatestRelease({
    currentVersion: "5.2.2",
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return new Response(JSON.stringify(release()), { status: 200 });
    },
  });

  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/HeiGeAi/heige-codex-skin-studio/releases/latest",
  );
  assert.equal(requestedOptions.redirect, "error");
  assert.equal(requestedOptions.headers.Accept, "application/vnd.github+json");
  assert.deepEqual(result, {
    status: "update-available",
    currentVersion: "5.2.2",
    latestVersion: "5.3.0",
    releaseUrl: RELEASE_URL,
  });
});

test("reports latest when the installed version is equal to or ahead of GitHub", async () => {
  for (const currentVersion of ["5.3.0", "5.4.0"]) {
    assert.deepEqual(
      await checkLatestRelease({
        currentVersion,
        fetchImpl: async () =>
          new Response(JSON.stringify(release()), { status: 200 }),
      }),
      {
        status: "latest",
        currentVersion,
        latestVersion: "5.3.0",
        releaseUrl: RELEASE_URL,
      },
    );
  }
});

test("rejects non-success oversized malformed and untrusted releases", async () => {
  const responses = [
    new Response("rate limited", { status: 403 }),
    new Response("x".repeat(32 * 1024 + 1), { status: 200 }),
    new Response("{", { status: 200 }),
    new Response(
      JSON.stringify(release({ draft: true })),
      { status: 200 },
    ),
    new Response(
      JSON.stringify(release({ prerelease: true })),
      { status: 200 },
    ),
    new Response(
      JSON.stringify(release({
        tag_name: "v5.3.0-beta.1",
        html_url:
          "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.3.0-beta.1",
      })),
      { status: 200 },
    ),
    new Response(
      JSON.stringify(release({
        html_url: "https://github.com/HeiGeAi/other/releases/tag/v5.3.0",
      })),
      { status: 200 },
    ),
    new Response(
      JSON.stringify(release({
        html_url:
          "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v9.9.9",
      })),
      { status: 200 },
    ),
  ];

  for (const response of responses) {
    await assert.rejects(
      checkLatestRelease({
        currentVersion: "5.2.2",
        fetchImpl: async () => response,
      }),
      /update check failed/i,
    );
  }
});

test("times out a GitHub request without leaking its underlying error", async () => {
  await assert.rejects(
    checkLatestRelease({
      currentVersion: "5.2.2",
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) =>
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("private network detail", "AbortError")),
            { once: true },
          );
        }),
    }),
    (error) => {
      assert.equal(error.message, "update check failed");
      assert.doesNotMatch(error.message, /private network detail/);
      return true;
    },
  );
});

test("cached checker reuses success for sixty seconds and coalesces in-flight work", async () => {
  let now = 1_000;
  let calls = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const check = createCachedUpdateChecker({
    currentVersion: "5.2.2",
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return await fetchPromise;
    },
  });

  const first = check();
  const second = check();
  assert.equal(calls, 1);
  resolveFetch(new Response(JSON.stringify(release()), { status: 200 }));
  assert.deepEqual(await first, await second);

  await check();
  assert.equal(calls, 1);

  now += 60_001;
  const refreshed = createCachedUpdateChecker({
    currentVersion: "5.2.2",
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(release()), { status: 200 });
    },
  });
  await refreshed();
  assert.equal(calls, 2);
});

test("cached checker does not cache failures", async () => {
  let calls = 0;
  const check = createCachedUpdateChecker({
    currentVersion: "5.2.2",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("offline", { status: 503 });
      return new Response(JSON.stringify(release()), { status: 200 });
    },
  });

  await assert.rejects(check(), /update check failed/i);
  assert.equal((await check()).status, "update-available");
  assert.equal(calls, 2);
});
