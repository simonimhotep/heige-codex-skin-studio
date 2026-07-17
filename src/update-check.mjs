import { readFile } from "node:fs/promises";

const PACKAGE_URL = new URL("../package.json", import.meta.url);
const PACKAGE_NAME = "heige-codex-skin-studio";
const RELEASE_API =
  "https://api.github.com/repos/HeiGeAi/heige-codex-skin-studio/releases/latest";
const RELEASE_PAGE =
  /^https:\/\/github\.com\/HeiGeAi\/heige-codex-skin-studio\/releases\/tag\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_MS = 60_000;

export function parseStableVersion(value) {
  if (typeof value !== "string") {
    throw new Error("stable version must be canonical X.Y.Z");
  }
  const match = STABLE_VERSION.exec(value);
  if (!match) throw new Error("stable version must be canonical X.Y.Z");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("stable version component exceeds safe integer range");
  }
  return parts;
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

export async function readCurrentPackageVersion({
  readFileImpl = readFile,
  packageUrl = PACKAGE_URL,
} = {}) {
  if (typeof readFileImpl !== "function") {
    throw new TypeError("readFileImpl must be a function");
  }
  const value = await readFileImpl(packageUrl, "utf8");
  if (typeof value !== "string") throw new Error("package metadata must be text");
  if (Buffer.byteLength(value) > MAX_PACKAGE_BYTES) {
    throw new Error("package metadata is too large");
  }
  let metadata;
  try {
    metadata = JSON.parse(value);
  } catch (error) {
    throw new Error("package metadata is invalid JSON", { cause: error });
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.name !== PACKAGE_NAME
  ) {
    throw new Error("unexpected package identity");
  }
  parseStableVersion(metadata.version);
  return metadata.version;
}

function checkedResponseLength(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return;
  if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
    throw new Error("update check failed");
  }
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BYTES) {
    throw new Error("update check failed");
  }
}

function normalizedRelease(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.tag_name !== "string" ||
    typeof value.html_url !== "string"
  ) {
    throw new Error("update check failed");
  }
  const tagMatch = /^v(.+)$/.exec(value.tag_name);
  const pageMatch = RELEASE_PAGE.exec(value.html_url);
  if (!tagMatch || !pageMatch) throw new Error("update check failed");
  const latestVersion = tagMatch[1];
  parseStableVersion(latestVersion);
  if (`${pageMatch[1]}.${pageMatch[2]}.${pageMatch[3]}` !== latestVersion) {
    throw new Error("update check failed");
  }
  return {
    latestVersion,
    releaseUrl: value.html_url,
  };
}

export async function checkLatestRelease({
  currentVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  parseStableVersion(currentVersion);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    throw new RangeError("timeoutMs must be an integer from 1 through 30000");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RELEASE_API, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": PACKAGE_NAME,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (
      response === null ||
      typeof response !== "object" ||
      response.ok !== true ||
      typeof response.text !== "function" ||
      response.headers === null ||
      typeof response.headers?.get !== "function"
    ) {
      throw new Error("update check failed");
    }
    checkedResponseLength(response);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error("update check failed");
    }
    let rawRelease;
    try {
      rawRelease = JSON.parse(text);
    } catch (error) {
      throw new Error("update check failed", { cause: error });
    }
    const release = normalizedRelease(rawRelease);
    return {
      status:
        compareStableVersions(currentVersion, release.latestVersion) < 0
          ? "update-available"
          : "latest",
      currentVersion,
      ...release,
    };
  } catch (error) {
    throw new Error("update check failed", { cause: error });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createCachedUpdateChecker({
  currentVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheMs = DEFAULT_CACHE_MS,
  now = Date.now,
} = {}) {
  parseStableVersion(currentVersion);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 300_000) {
    throw new RangeError("cacheMs must be an integer from 0 through 300000");
  }
  let cached = null;
  let inFlight = null;

  return async function checkForUpdate() {
    const timestamp = now();
    if (
      cached !== null &&
      Number.isFinite(timestamp) &&
      timestamp - cached.checkedAt <= cacheMs
    ) {
      return structuredClone(cached.result);
    }
    if (inFlight !== null) return await inFlight;

    inFlight = checkLatestRelease({
      currentVersion,
      fetchImpl,
      timeoutMs,
    }).then((result) => {
      const checkedAt = now();
      if (Number.isFinite(checkedAt)) {
        cached = {
          checkedAt,
          result: structuredClone(result),
        };
      }
      return result;
    });
    try {
      return structuredClone(await inFlight);
    } finally {
      inFlight = null;
    }
  };
}
