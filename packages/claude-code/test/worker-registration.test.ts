import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES as MAX_BYTES,
  ClaudeCodeWorkerRegistrationError, decodeClaudeCodeWorkerRegistration as decode,
  encodeClaudeCodeWorkerRegistration as encode,
  type ClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope,
} from "../src/worker-registration.js";

function fixture() {
  const scope: ClaudeCodeWorkerRegistrationScope = {
    sessionId: "runtime-session", ownerId: "owner-a", generation: "generation-a",
    reservationId: "01234567-89ab-cdef-0123-456789abcdef",
    workerExecutable: "/usr/local/bin/node", cwd: "/work/project", nativeConfigRoot: "/home/user/.claude",
  };
  const registration: ClaudeCodeWorkerRegistration = {
    version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid: 12345, processGroupId: 12345, endpoint: "http://127.0.0.1:34567", token: "a".repeat(64),
    createdAt: "2026-11-09T20:00:00.000Z",
  };
  return { registration, scope };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function rejected(code?: ClaudeCodeWorkerRegistrationError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ClaudeCodeWorkerRegistrationError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, `Claude Code worker registration rejected (${error.code})`);
    assert.doesNotMatch(error.message, /PRIVATE|provider|\/secret|secret-token/);
    assert.equal((error as Error).cause, undefined);
    return true;
  };
}
function refuses(value: unknown, scope: ClaudeCodeWorkerRegistrationScope, code?: ClaudeCodeWorkerRegistrationError["code"]) {
  assert.throws(() => encode(value as ClaudeCodeWorkerRegistration, scope), rejected(code));
  assert.throws(() => decode(bytes(value), scope), rejected(code));
}

test("pure roundtrip retains exact descriptor fields without interpreting process ownership", () => {
  const { registration, scope } = fixture();
  assert.deepEqual(decode(encode(registration, scope), scope), registration);
  const detached = { ...registration, processGroupId: null };
  assert.deepEqual(decode(encode(detached, scope), scope), detached);
  const reordered = Object.fromEntries(Object.entries(registration).reverse());
  assert.deepEqual(decode(bytes(reordered), scope), registration);
  const nullPrototype = Object.assign(Object.create(null), registration);
  assert.deepEqual(decode(encode(nullPrototype, scope), scope), registration);
});

for (const [key, value] of Object.entries({
  sessionId: "other-session", ownerId: "owner-b", generation: "generation-b",
  reservationId: "11111111-2222-3333-4444-555555555555", workerExecutable: "/other/node",
  cwd: "/work/Project", nativeConfigRoot: "/other/config",
})) test(`exact scope mismatch refuses: ${key}`, () => {
  const { registration, scope } = fixture();
  refuses({ ...registration, [key]: value }, scope, "scope_mismatch");
  assert.throws(() => encode(registration, { ...scope, [key]: value }), rejected("scope_mismatch"));
  assert.throws(() => decode(bytes(registration), { ...scope, [key]: value }), rejected("scope_mismatch"));
});

for (const key of Object.keys(fixture().registration)) test(`missing field refuses: ${key}`, () => {
  const { registration, scope } = fixture();
  const incomplete = { ...registration } as Record<string, unknown>; delete incomplete[key];
  refuses(incomplete, scope, "invalid_registration");
});

for (const extra of ["providerCredential", "environment", "prompt", "nativePath", "__proto__", "constructor"]) {
  test(`unknown/secret-bearing descriptor field refuses: ${extra}`, () => {
    const { registration, scope } = fixture();
    refuses({ ...registration, [extra]: "PRIVATE_PROVIDER_SECRET" }, scope, "invalid_registration");
  });
}

test("symbols, nonenumerable extras, accessors and inherited fields cannot bypass exact snapshots", () => {
  const { registration, scope } = fixture();
  assert.throws(() => encode({ ...registration, [Symbol("PRIVATE_EXTRA")]: "PRIVATE" }, scope), rejected("invalid_registration"));
  const extra = { ...registration }; Object.defineProperty(extra, "secret", { value: "PRIVATE" });
  assert.throws(() => encode(extra, scope), rejected("invalid_registration"));
  let getterCalls = 0;
  const getter = { ...registration }; Object.defineProperty(getter, "token", { get() { getterCalls++; throw new Error("PRIVATE_GETTER"); } });
  assert.throws(() => encode(getter, scope), rejected("invalid_registration")); assert.equal(getterCalls, 0);
  assert.throws(() => encode(Object.create(registration), scope), rejected("invalid_registration"));
  const throwing = new Proxy(registration, { ownKeys() { throw new Error("PRIVATE_PROXY"); } });
  assert.throws(() => encode(throwing, scope), rejected("invalid_registration"));
});

for (const value of [undefined, null, [], {}, "PRIVATE_SCOPE"]) test(`invalid expected scope refuses: ${JSON.stringify(value)}`, () => {
  const { registration } = fixture();
  assert.throws(() => encode(registration, value as any), rejected("invalid_scope"));
  assert.throws(() => decode(bytes(registration), value as any), rejected("invalid_scope"));
});
for (const key of Object.keys(fixture().scope)) test(`missing expected scope field refuses: ${key}`, () => {
  const { registration, scope } = fixture();
  const incomplete = { ...scope } as Record<string, unknown>; delete incomplete[key];
  assert.throws(() => encode(registration, incomplete as any), rejected("invalid_scope"));
  assert.throws(() => decode(bytes(registration), incomplete as any), rejected("invalid_scope"));
});

test("expected scope validates formats and never invokes accessors or infers defaults", () => {
  const { registration, scope } = fixture();
  for (const patch of [{ ownerId: "../owner" }, { reservationId: "UPPERCASE" }, { cwd: "relative" },
    { nativeConfigRoot: "/a/../b" }, { environment: "PRIVATE" }]) {
    assert.throws(() => encode(registration, { ...scope, ...patch }), rejected("invalid_scope"));
    assert.throws(() => decode(bytes(registration), { ...scope, ...patch }), rejected("invalid_scope"));
  }
  let calls = 0;
  Object.defineProperty(scope, "cwd", { get() { calls++; return "/secret"; } });
  assert.throws(() => encode(registration, scope), rejected("invalid_scope")); assert.equal(calls, 0);
});

for (const version of [0, 2, "1", null]) test(`unsupported version refuses: ${version}`, () => {
  const { registration, scope } = fixture(); refuses({ ...registration, version }, scope, "unsupported_version");
});
for (const [key, value] of [
  ["runtime", "pi"], ["ownership", "attached"], ["sessionId", ""], ["ownerId", "../owner"],
  ["generation", "g".repeat(129)], ["ownerId", "owner\0secret"], ["sessionId", 42],
  ["reservationId", "01234567-89AB-CDEF-0123-456789ABCDEF"], ["reservationId", "../../private"],
  ["token", "a".repeat(63)], ["token", "A".repeat(64)], ["token", "PRIVATE_PROVIDER_SECRET"], ["token", null],
  ["createdAt", "2026-11-09T20:00:00Z"], ["createdAt", "2026-11-09T21:00:00.000+01:00"],
  ["createdAt", "2026-02-30T20:00:00.000Z"], ["createdAt", "not-a-date"], ["createdAt", 0],
] as [string, unknown][]) test(`malformed descriptor field refuses: ${key}=${String(value)}`, () => {
  const { registration, scope } = fixture(); refuses({ ...registration, [key]: value }, scope, "invalid_registration");
});

for (const pid of [0, -1, -0, 1.5, 2_147_483_648, "12345", null, true, NaN, Infinity]) test(`invalid PID refuses: ${String(pid)}`, () => {
  const { registration, scope } = fixture(); refuses({ ...registration, pid, processGroupId: pid }, scope, "invalid_registration");
});
for (const group of [0, -1, 12346, "12345", false, {}, undefined]) test(`invalid process group refuses: ${String(group)}`, () => {
  const { registration, scope } = fixture(); refuses({ ...registration, processGroupId: group }, scope);
});

test("valid identity/PID/path/token/date boundaries roundtrip exactly", () => {
  const { registration, scope } = fixture();
  for (const pid of [1, 2_147_483_647]) for (const processGroupId of [pid, null]) {
    const value = { ...registration, pid, processGroupId };
    assert.deepEqual(decode(encode(value, scope), scope), value);
  }
  const boundaryScope = { ...scope, sessionId: "S".repeat(128), ownerId: "O".repeat(128), generation: "G".repeat(128),
    workerExecutable: "/" + "a".repeat(4095), cwd: "/" + "b".repeat(4095), nativeConfigRoot: "/" + "c".repeat(4095) };
  const boundary = { ...registration, ...boundaryScope, token: "f".repeat(64) };
  assert.deepEqual(decode(encode(boundary, boundaryScope), boundaryScope), boundary);
  const unicodeScope = { ...scope, cwd: "/work/é/日本語" };
  assert.equal(decode(encode({ ...registration, ...unicodeScope }, unicodeScope), unicodeScope).cwd, unicodeScope.cwd);
  for (const createdAt of ["1970-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"]) {
    assert.equal(decode(encode({ ...registration, createdAt }, scope), scope).createdAt, createdAt);
  }
});

for (const value of ["relative", "", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0secret", "/" + "a".repeat(4096), "/" + "é".repeat(2048), "/bad\ud800"]) {
  test(`invalid absolute/normalized/UTF8 path refuses: ${JSON.stringify(value).slice(0, 70)}`, () => {
    const { registration, scope } = fixture();
    for (const key of ["workerExecutable", "cwd", "nativeConfigRoot"] as const) {
      refuses({ ...registration, [key]: value }, scope, "invalid_registration");
      assert.throws(() => encode(registration, { ...scope, [key]: value }), rejected("invalid_scope"));
    }
  });
}
for (const endpoint of [
  "not-an-endpoint", "https://127.0.0.1:34567", "http://localhost:34567", "http://example.com:34567", "http://[::1]:34567",
  "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1", "http://127.0.0.1:80",
  "http://127.0.0.1:034567", "http://127.0.0.1:34567/", "http://127.0.0.1:34567/path", "http://127.0.0.1:34567?q=PRIVATE",
  "http://127.0.0.1:34567#PRIVATE", "http://PRIVATE@127.0.0.1:34567", "http://127.1:34567", "http://2130706433:34567",
  "HTTP://127.0.0.1:34567", " http://127.0.0.1:34567", "http://127.0.0.1:34567\n",
]) test(`noncanonical/nonloopback endpoint refuses: ${JSON.stringify(endpoint)}`, () => {
  const { registration, scope } = fixture(); refuses({ ...registration, endpoint }, scope, "invalid_registration");
});
test("canonical explicit port endpoints at valid boundaries roundtrip", () => {
  const { registration, scope } = fixture();
  for (const port of [1, 81, 65535]) {
    const endpoint = `http://127.0.0.1:${port}`;
    assert.equal(decode(encode({ ...registration, endpoint }, scope), scope).endpoint, endpoint);
  }
});

for (const source of ["", "{", "null", "[]", "42", '"PRIVATE"', "{}", '{"secret":"PRIVATE"}', "{} trailing", "\ufeff{}"])
  test(`malformed JSON/shape refuses: ${JSON.stringify(source)}`, () => {
    const { scope } = fixture(); assert.throws(() => decode(new TextEncoder().encode(source), scope), rejected());
  });
for (const payload of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0xed, 0xa0, 0x80])])
  test(`malformed UTF8 refuses: ${String(payload)}`, () => {
    const { scope } = fixture(); assert.throws(() => decode(payload, scope), rejected("invalid_utf8"));
  });
for (const payload of ["PRIVATE", null, undefined, [], new ArrayBuffer(10), new DataView(new ArrayBuffer(10))])
  test(`non-byte payload refuses: ${String(payload)}`, () => {
    const { scope } = fixture(); assert.throws(() => decode(payload as any, scope), rejected("invalid_payload"));
  });

test("UTF8 byte limit is exact on decode, and encode checks serialized bytes rather than character count", () => {
  const { registration, scope } = fixture();
  const encoded = encode(registration, scope);
  const exact = new Uint8Array(MAX_BYTES).fill(32); exact.set(encoded);
  assert.deepEqual(decode(exact, scope), registration);
  assert.throws(() => decode(new Uint8Array(MAX_BYTES + 1), scope), rejected("payload_too_large"));
  const escaped = "/" + '"'.repeat(4095);
  const bigScope = { ...scope, cwd: escaped, workerExecutable: escaped, nativeConfigRoot: escaped };
  assert.throws(() => encode({ ...registration, ...bigScope }, bigScope), rejected("payload_too_large"));
});

test("caller exceptions are fresh bounded errors without inspecting hostile error properties", () => {
  const { registration, scope } = fixture();
  for (const kind of ["descriptor", "encode-scope", "decode-scope", "payload"] as const) {
    for (const poisonKind of ["exported-error", "invalid-code", "code-getter", "proxy", "revoked-proxy", "previous-rejection", "primitive"] as const) {
      let inspected = 0;
      let poison: unknown = new ClaudeCodeWorkerRegistrationError("scope_mismatch");
      if (poisonKind === "primitive") poison = "PRIVATE_THROWN_STRING";
      else if (poisonKind === "previous-rejection") {
        try { decode(new Uint8Array([0xff]), scope); } catch (error) { poison = error; }
      } else if (poisonKind === "proxy") {
        poison = new Proxy({}, { get() { inspected++; throw new Error("PRIVATE_GET"); },
          getPrototypeOf() { inspected++; throw new Error("PRIVATE_PROTOTYPE"); } });
      } else if (poisonKind === "revoked-proxy") {
        const revoked = Proxy.revocable({}, {}); revoked.revoke(); poison = revoked.proxy;
      } else {
        const error = poison as ClaudeCodeWorkerRegistrationError;
        error.message = "PRIVATE_MESSAGE"; error.cause = new Error("PRIVATE_CAUSE");
        if (poisonKind === "invalid-code") Object.defineProperty(error, "code", { value: "PRIVATE_INVALID_CODE" });
        if (poisonKind === "code-getter") Object.defineProperty(error, "code", { get() { inspected++; throw new Error("PRIVATE_CODE_GETTER"); } });
      }
      const trap = <T extends object>(value: T): T => new Proxy(value, { ownKeys() { throw poison; } });
      const payload = bytes(registration);
      Object.defineProperty(payload, "byteLength", { get() { throw poison; } });
      const operation = kind === "descriptor" ? () => encode(trap(registration), scope)
        : kind === "encode-scope" ? () => encode(registration, trap(scope))
          : kind === "decode-scope" ? () => decode(bytes(registration), trap(scope))
            : () => decode(payload, scope);
      assert.throws(operation, (error: unknown) => {
        assert.notEqual(error, poison);
        return rejected(kind.includes("scope") ? "invalid_scope" : "invalid_registration")(error);
      });
      assert.equal(inspected, 0, `${kind}/${poisonKind} must not inspect caller exception properties`);
    }
  }
});

test("documented internal error codes survive sanitization", () => {
  const { registration, scope } = fixture();
  const cases: [() => unknown, ClaudeCodeWorkerRegistrationError["code"]][] = [
    [() => encode({ ...registration, version: 2 } as any, scope), "unsupported_version"],
    [() => decode(bytes({ ...registration, ownerId: "other" }), scope), "scope_mismatch"],
    [() => decode(new Uint8Array([0xff]), scope), "invalid_utf8"],
    [() => decode(new Uint8Array([123]), scope), "invalid_json"],
    [() => decode(null as any, scope), "invalid_payload"],
    [() => decode(new Uint8Array(MAX_BYTES + 1), scope), "payload_too_large"],
    [() => encode({ ...registration, token: "PRIVATE" }, scope), "invalid_registration"],
    [() => encode(registration, { ...scope, cwd: "relative" }), "invalid_scope"],
  ];
  for (const [operation, code] of cases) assert.throws(operation, rejected(code));
});

test("encode/decode snapshots are isolated from caller objects and byte-buffer mutation", () => {
  const { registration, scope } = fixture();
  const original = { ...registration };
  const encoded = encode(registration, scope), separatelyEncoded = encode(registration, scope);
  assert.notEqual(encoded, separatelyEncoded);
  registration.token = "b".repeat(64); registration.pid = 999; scope.ownerId = "changed";
  const expected = fixture().scope;
  const decoded = decode(encoded, expected);
  assert.deepEqual(decoded, original);
  decoded.token = "c".repeat(64); assert.deepEqual(decode(encoded, expected), original);
  encoded.fill(0); assert.deepEqual(decode(separatelyEncoded, expected), original);
  const paddedBuffer = Buffer.concat([Buffer.from([0xff]), Buffer.from(separatelyEncoded), Buffer.from([0xff])]);
  assert.deepEqual(decode(paddedBuffer.subarray(1, paddedBuffer.length - 1), expected), original);
});
