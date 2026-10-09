/**
 * dsh-session-delete — Host half.
 *
 * Exposes one loopback HTTP endpoint that permanently removes a conversation
 * together with every subagent conversation it spawned, at any depth.
 *
 * Lineage: a session belongs to the tree when its header says
 * `origin: "subagent"` and its `parentSession` is already in the tree — the
 * same rule DSH's archive gate follows. Forks also carry `parentSession` but
 * no `origin`; they are independent conversations and are never removed.
 *
 * Removal of one session:
 *   detach live entry → workspace accounting → log directory (searched in
 *   every project directory) → projection cache → spill directory → pin.
 * The live entry is detached before the cache is removed because detaching
 * checkpoints that cache one last time.
 *
 * Anything a still-running writer keeps open is recorded in a leftovers file
 * and removed on the next start, when no session is live.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

export const name = "dsh-session-delete";
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence", "sessions"];

export const ENDPOINT = "/api/dsh-session-delete/purge";
export const REQUEST_HEADER = "x-dsh-session-delete";

const LOG = "[dsh-session-delete]";
const SETTLE_MS = 1200;
const ATTEMPTS = 4;
const ATTEMPT_GAP_MS = 800;
const MAX_BODY_BYTES = 16 * 1024;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const message = (error) => String(error?.message ?? error);

// ---------------------------------------------------------------- paths ----

/** `$DSH_HOME`, else `~/.dsh` (blank values count as unset). */
function harnessHome() {
  const raw = process.env.DSH_HOME?.trim();
  if (!raw) return resolve(homedir(), ".dsh");
  if (raw === "~") return homedir();
  if (/^~[\\/]/.test(raw)) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

/** Directory-name encoding used by the session log and spill stores. */
function pathSegment(value) {
  if (value === ".") return "~002E";
  if (value === "..") return "~002E~002E";
  return value.replace(/[^A-Za-z0-9._-]/g, (ch) => "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
}

const isSessionId = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(value);

async function present(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function childNames(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// -------------------------------------------------------------- lineage ----

/** Headers from persistence, plus sessions that exist only in memory so far. */
async function knownHeaders(ctx) {
  const headers = new Map();
  for (const snapshot of await ctx.sessionPersistence.list()) {
    if (snapshot?.header?.id) headers.set(snapshot.header.id, snapshot.header);
  }
  for (const session of ctx.sessions.list?.() ?? []) {
    const header = session?.header;
    if (header?.id && !headers.has(header.id)) headers.set(header.id, header);
  }
  return headers;
}

/**
 * Subagent sessions below `rootId`, deepest first, so a child is always
 * removed before its parent. Fork edges are ignored.
 */
export function subagentDescendants(headers, rootId) {
  const children = new Map();
  for (const header of headers) {
    if (header?.origin !== "subagent" || typeof header.parentSession !== "string" || !header.id) continue;
    if (!children.has(header.parentSession)) children.set(header.parentSession, []);
    children.get(header.parentSession).push(header.id);
  }
  const ordered = [];
  const reached = new Set([rootId]);
  const walk = (parent) => {
    for (const child of children.get(parent) ?? []) {
      if (reached.has(child)) continue;
      reached.add(child);
      walk(child);
      ordered.push(child);
    }
  };
  walk(rootId);
  return ordered;
}

// -------------------------------------------------------------- removal ----

function locations(ctx, id) {
  const home = harnessHome();
  const configured = ctx.sessionPersistence?.root;
  return {
    sessionsRoot: typeof configured === "string" && configured ? configured : join(home, "sessions"),
    cacheFile: join(home, "storages", "session_projcache", "sessions", `${id}.json`)
  };
}

/** A session's log directory may sit under any project directory. */
async function logDirs(sessionsRoot, id) {
  const segment = pathSegment(id);
  const found = [];
  for (const project of await childNames(sessionsRoot)) {
    const dir = join(sessionsRoot, project, segment);
    if (await present(dir)) found.push(dir);
  }
  return found;
}

/** Remove the log directories and projection cache, then confirm on disk. */
async function removeStoredFiles(ctx, id) {
  const { sessionsRoot, cacheFile } = locations(ctx, id);
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const targets = [...(await logDirs(sessionsRoot, id)), cacheFile];
    for (const target of targets) {
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      } catch (error) {
        lastError = error;
      }
    }
    const remaining = await logDirs(sessionsRoot, id);
    if (await present(cacheFile)) remaining.push(cacheFile);
    if (remaining.length === 0) return { done: true };
    lastError ??= new Error(`still on disk: ${remaining.join(", ")}`);
    if (attempt < ATTEMPTS) await wait(ATTEMPT_GAP_MS);
  }
  return { done: false, error: message(lastError) };
}

async function removeSpill(ctx, id) {
  const hashed = `session-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
  const roots = (await childNames(tmpdir()))
    .filter((entry) => /^dsh-spill-[A-Za-z0-9]{6}$/.test(entry))
    .map((entry) => join(tmpdir(), entry));
  const configured = ctx.get?.("spillStore")?.root;
  if (typeof configured === "string") roots.push(configured);
  for (const root of new Set(roots)) {
    await rm(join(root, hashed), { recursive: true, force: true }).catch(() => {});
  }
}

async function removeSession(ctx, id, header) {
  const registry = ctx.workspaceRegistry;
  try {
    // SessionStore exposes no public eviction; its entry carries the detach
    // capability that tears down publication and emits session/disposed.
    ctx.sessions.store?.get(id)?.detach?.();
  } catch (error) {
    ctx.logger?.warn?.(`${LOG} detach ${id}: ${message(error)}`);
  }
  if (typeof header?.cwd === "string") {
    try {
      await (await registry.resolveByPath(header.cwd))?.detachSession(id);
    } catch (error) {
      ctx.logger?.warn?.(`${LOG} workspace ${id}: ${message(error)}`);
    }
  }
  try {
    await ctx.get?.("sessionProjectionCache")?.table?.delete?.(id);
  } catch { /* the file removal below covers it */ }
  const result = await removeStoredFiles(ctx, id);
  await removeSpill(ctx, id);
  if (registry.pinnedSessionIds?.includes(id)) await registry.unpinSession(id).catch(() => {});
  return result;
}

/**
 * Remove `rootId` and its whole subagent tree.
 * @param options.dryRun  only report the tree size
 * @param options.settleMs  wait after stopping work before touching files
 */
export async function purgeSessionTree(ctx, rootId, { dryRun = false, settleMs = SETTLE_MS } = {}) {
  if (!isSessionId(rootId)) return { ok: false, reason: "invalid-id" };
  let headers;
  try {
    headers = await knownHeaders(ctx);
  } catch (error) {
    return { ok: false, reason: "list-failed", message: message(error) };
  }
  if (!headers.has(rootId)) return { ok: false, reason: "not-found" };

  const descendants = subagentDescendants(headers.values(), rootId);
  if (dryRun) return { ok: true, dryRun: true, subagents: descendants.length };

  const registry = ctx.workspaceRegistry;
  // Archiving the root first stops its work, and DSH's pre-step gate follows
  // subagent lineage, so nothing in the tree can wake while files go away.
  await registry.archiveSession(rootId, { stopActivity: true }).catch((error) => {
    ctx.logger?.warn?.(`${LOG} archive ${rootId}: ${message(error)}`);
  });
  for (const id of descendants) {
    await ctx.parallel?.("workspace/session-stop", { sessionId: id }).catch(() => {});
  }
  if (settleMs > 0) await wait(settleMs);

  const removed = [];
  const leftover = [];
  for (const id of [...descendants, rootId]) {
    const result = await removeSession(ctx, id, headers.get(id));
    if (result.done) {
      removed.push(id);
      await leftovers.forget(id);
    } else {
      leftover.push(id);
      await leftovers.remember(id);
      ctx.logger?.warn?.(`${LOG} ${id} left for next start: ${result.error}`);
    }
  }
  // While the root's files are still held it stays archived (hidden); the
  // next-start cleanup clears that mark together with the files.
  if (!leftover.includes(rootId)) await registry.unarchiveSession(rootId).catch(() => {});
  return { ok: true, removed, leftover, subagents: descendants.length };
}

// ------------------------------------------------------------ leftovers ----

const leftovers = {
  file: () => join(harnessHome(), "dsh-session-delete", "leftovers.json"),
  async read() {
    try {
      const value = JSON.parse(await readFile(this.file(), "utf8"));
      return Array.isArray(value) ? value.filter(isSessionId) : [];
    } catch {
      return [];
    }
  },
  async write(ids) {
    const file = this.file();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(ids, null, 2) + "\n", "utf8");
  },
  async remember(id) {
    const ids = await this.read();
    if (!ids.includes(id)) await this.write([...ids, id]).catch(() => {});
  },
  async forget(id) {
    const ids = await this.read();
    if (ids.includes(id)) await this.write(ids.filter((other) => other !== id)).catch(() => {});
  }
};

/** On start no session is live, so whatever was held before can go now. */
async function clearLeftovers(ctx) {
  for (const id of await leftovers.read()) {
    const result = await removeStoredFiles(ctx, id);
    if (!result.done) {
      ctx.logger?.warn?.(`${LOG} ${id} still held: ${result.error}`);
      continue;
    }
    await ctx.workspaceRegistry.unarchiveSession(id).catch(() => {});
    await leftovers.forget(id);
  }
}

// ------------------------------------------------------------- endpoint ----

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Only same-machine callers that set our header. A cross-site page cannot add
 * a custom header without a CORS preflight, which this route never answers.
 */
function trusted(req) {
  if (!LOOPBACK_PEERS.has(req.socket?.remoteAddress)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (req.headers[REQUEST_HEADER] !== "1") return false;
  return String(req.headers["content-type"] ?? "").startsWith("application/json");
}

function readJson(req) {
  return new Promise((done, fail) => {
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("body too large"));
        req.destroy?.();
      } else parts.push(part);
    });
    req.on("end", () => {
      try {
        done(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (error) {
        fail(error);
      }
    });
    req.on("error", fail);
  });
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function apply(ctx) {
  void clearLeftovers(ctx).catch((error) => ctx.logger?.warn?.(`${LOG} startup cleanup: ${message(error)}`));
  const unregister = ctx.webServer.register({
    kind: "exact",
    path: ENDPOINT,
    handler: async (req, res) => {
      if (req.method !== "POST") return reply(res, 405, { ok: false, reason: "method" });
      if (!trusted(req)) return reply(res, 403, { ok: false, reason: "forbidden" });
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return reply(res, 400, { ok: false, reason: "bad-request", message: message(error) });
      }
      try {
        const result = await purgeSessionTree(ctx, body.sessionId, { dryRun: body.dryRun === true });
        return reply(res, result.ok ? 200 : 409, result);
      } catch (error) {
        ctx.logger?.error?.(`${LOG} ${message(error)}`);
        return reply(res, 500, { ok: false, reason: "internal", message: message(error) });
      }
    }
  });
  ctx.effect?.(() => unregister, "dsh-session-delete endpoint");
}
