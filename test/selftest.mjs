// Offline self-test: a fake Host context over real temporary directories.
// Never reads or writes the real ~/.dsh.
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const home = await mkdtemp(join(tmpdir(), "dsh-session-delete-test-"));
process.env.DSH_HOME = home;
const plugin = await import("../lib/index.js");
const { purgeSessionTree, subagentDescendants, apply, ENDPOINT, REQUEST_HEADER } = plugin;

let passed = 0;
let failed = 0;
const check = (label, condition) => {
  condition ? passed++ : failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
};

const sessionsRoot = join(home, "sessions");
const cacheDir = join(home, "storages", "session_projcache", "sessions");
await mkdir(cacheDir, { recursive: true });
const PROJECT = "--C-work-demo--";

async function seed(header, project = PROJECT) {
  const dir = join(sessionsRoot, project, header.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.v4.jsonl.zstd"), "x");
  await writeFile(join(cacheDir, `${header.id}.json`), "{}");
}

function fakeHost(headers, record) {
  return {
    sessionPersistence: { root: sessionsRoot, list: async () => headers.map((header) => ({ header })) },
    sessions: { list: () => [], store: { get: () => undefined } },
    workspaceRegistry: {
      pinnedSessionIds: [],
      archiveSession: async (id) => void record.archived.add(id),
      unarchiveSession: async (id) => void record.archived.delete(id),
      unpinSession: async () => {},
      resolveByPath: async () => ({ detachSession: async (id) => void record.detached.push(id) })
    },
    parallel: async (_event, { sessionId }) => void record.stopped.push(sessionId),
    get: () => undefined,
    logger: { warn() {}, info() {}, error() {} }
  };
}
const freshRecord = () => ({ archived: new Set(), detached: [], stopped: [] });

// --- lineage ---------------------------------------------------------------
// A → s1 → s1a, A → s2 are subagents. F forks A and s1f forks s1: both are
// independent conversations. B is unrelated.
const headers = [
  { id: "A", cwd: "C:\\work\\demo" },
  { id: "s1", cwd: "C:\\work\\demo", parentSession: "A", origin: "subagent" },
  { id: "s1a", cwd: "C:\\work\\demo", parentSession: "s1", origin: "subagent" },
  { id: "s2", cwd: "C:\\work\\demo", parentSession: "A", origin: "subagent" },
  { id: "F", cwd: "C:\\work\\demo", parentSession: "A", isSeeded: true },
  { id: "s1f", cwd: "C:\\work\\demo", parentSession: "s1", isSeeded: true },
  { id: "B", cwd: "C:\\work\\demo" }
];
for (const header of headers) await seed(header);

const order = subagentDescendants(headers, "A");
check("tree holds exactly the subagents", JSON.stringify([...order].sort()) === '["s1","s1a","s2"]');
check("children precede their parent", order.indexOf("s1a") < order.indexOf("s1"));
check("a lone conversation has no tree", subagentDescendants(headers, "B").length === 0);

// --- purge -------------------------------------------------------------------
const record = freshRecord();
const host = fakeHost(headers, record);

const dry = await purgeSessionTree(host, "A", { dryRun: true });
check("dry run reports 3 subagents", dry.ok && dry.subagents === 3);
check("dry run removes nothing", existsSync(join(sessionsRoot, PROJECT, "s1a")));

const result = await purgeSessionTree(host, "A", { settleMs: 0 });
const remaining = (await readdir(join(sessionsRoot, PROJECT))).sort();
check("purge succeeds without leftovers", result.ok && result.leftover.length === 0);
check("whole tree removed from disk", !["A", "s1", "s1a", "s2"].some((id) => remaining.includes(id)));
check("forks and unrelated sessions untouched", JSON.stringify(remaining) === '["B","F","s1f"]');
check("tree caches removed", !["A", "s1", "s1a", "s2"].some((id) => existsSync(join(cacheDir, `${id}.json`))));
check("other caches kept", ["B", "F", "s1f"].every((id) => existsSync(join(cacheDir, `${id}.json`))));
check("workspace accounting detached", ["A", "s1", "s1a", "s2"].every((id) => record.detached.includes(id)));
check("subagents stopped first", ["s1", "s1a", "s2"].every((id) => record.stopped.includes(id)));
check("root not left archived", !record.archived.has("A"));

check("unknown id refused", (await purgeSessionTree(host, "nope")).reason === "not-found");
check("traversal id refused", (await purgeSessionTree(host, "../x")).reason === "invalid-id");

await seed({ id: "C" }, "--elsewhere--");
const moved = await purgeSessionTree(fakeHost([{ id: "C", cwd: "Z:\\gone" }], freshRecord()), "C", { settleMs: 0 });
check("log found outside the cwd's project dir", moved.ok && !existsSync(join(sessionsRoot, "--elsewhere--", "C")));

// --- endpoint guard ------------------------------------------------------------
let handler;
apply({ ...fakeHost([], freshRecord()), webServer: { register: (route) => ((handler = route.handler), () => {}) }, effect() {} });
check("endpoint registered", typeof handler === "function");

async function call({ method = "POST", peer = "127.0.0.1", headers: extra = {}, body = "{}" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.socket = { remoteAddress: peer };
  req.headers = { "content-type": "application/json", [REQUEST_HEADER]: "1", ...extra };
  const res = { statusCode: 0, setHeader() {}, end(text) { this.body = text; } };
  const handled = handler(req, res);
  queueMicrotask(() => { req.emit("data", Buffer.from(body)); req.emit("end"); });
  await handled;
  return res.statusCode;
}
check("GET rejected", (await call({ method: "GET" })) === 405);
check("remote peer rejected", (await call({ peer: "10.0.0.5" })) === 403);
check("missing header rejected", (await call({ headers: { [REQUEST_HEADER]: undefined } })) === 403);
check("cross-site rejected", (await call({ headers: { "sec-fetch-site": "cross-site" } })) === 403);
check("form post rejected", (await call({ headers: { "content-type": "text/plain" } })) === 403);
check("trusted call reaches handler", (await call({ body: '{"sessionId":"nope"}' })) === 409);
check("endpoint path namespaced", ENDPOINT === "/api/dsh-session-delete/purge");

await rm(home, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
