import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as Y from "yjs";

const scrypt = promisify(scryptCb);
const PALETTE = ["#F45D5D", "#F2994A", "#F2C94C", "#6FCF97", "#2FD4C6", "#56CCF2", "#5B8DEF", "#9B51E0", "#EB5FA8", "#B7791F"];
const FILE = "db.json";

function send(res, status, body) {
  res.status(status).json(body);
}
function fail(res, status, error) {
  send(res, status, { error });
}
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function secret() {
  const value = (process.env.JWT_SECRET || "").trim();
  if (!value) throw new Error("JWT_SECRET is not set");
  return value;
}
function pickColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash << 5) - hash + seed.charCodeAt(i);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
async function hashPassword(plain) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(plain, salt, 32);
  return `scrypt$${salt}$${Buffer.from(derived).toString("base64url")}`;
}
async function verifyPassword(plain, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = Buffer.from(await scrypt(plain, salt, 32));
  const expected = Buffer.from(hash, "base64url");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function signToken(user) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    sub: user.id, email: user.email, name: user.name, color: user.color,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  }));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function readToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { id: payload.sub, email: payload.email, name: payload.name, color: payload.color };
}
function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  return readToken(String(header).replace(/^Bearer\s+/i, ""));
}
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, color: user.color };
}

function emptyState() {
  const doc = new Y.Doc();
  doc.getText("quill");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return Buffer.from(update).toString("base64");
}
function mergeState(stateB64, updateB64) {
  const doc = new Y.Doc();
  if (stateB64) Y.applyUpdate(doc, Buffer.from(stateB64, "base64"));
  Y.applyUpdate(doc, Buffer.from(updateB64, "base64"));
  const next = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return next;
}

function token() {
  const value = (process.env.MIDDOCS_GITHUB_TOKEN || "").trim();
  if (!value) throw new Error("MIDDOCS_GITHUB_TOKEN is not set");
  return value;
}
function gistId() {
  const value = (process.env.MIDDOCS_GIST_ID || "").trim();
  if (!value) throw new Error("MIDDOCS_GIST_ID is not set");
  return value;
}
function empty() {
  return { version: 0, users: [], documents: [], access: [], pending: [], awareness: [], signals: [], signalSeq: 0 };
}
let cached = null;
let cachedAt = 0;
async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "middocs",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
async function readDb(fresh = false) {
  if (!fresh && cached && Date.now() - cachedAt < 1000) return structuredClone(cached);
  const gist = await github("GET", `/gists/${gistId()}`);
  const file = gist.files?.[FILE];
  let db = empty();
  if (file?.content && !file.truncated) db = { ...empty(), ...JSON.parse(file.content) };
  else if (file?.raw_url) {
    const raw = await fetch(file.raw_url, { headers: { Authorization: `Bearer ${token()}`, "User-Agent": "middocs" } });
    db = { ...empty(), ...JSON.parse(await raw.text()) };
  }
  cached = db;
  cachedAt = Date.now();
  return structuredClone(db);
}
async function writeDb(db) {
  await github("PATCH", `/gists/${gistId()}`, { files: { [FILE]: { content: JSON.stringify(db) } } });
  cached = db;
  cachedAt = Date.now();
}
let queue = Promise.resolve();
function updateDb(mutator) {
  const run = queue.then(async () => {
    const db = await readDb(true);
    const next = await mutator(db);
    next.version = (db.version || 0) + 1;
    await writeDb(next);
    return next;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
function nowIso() { return new Date().toISOString(); }
function mapDocument(doc, db, viewerId) {
  const owner = db.users.find((user) => user.id === doc.ownerId);
  return {
    id: doc.id, title: doc.title, icon: doc.icon, ownerId: doc.ownerId,
    ownerName: owner?.name || "", isOwner: doc.ownerId === viewerId,
    updatedAt: doc.updatedAt, createdAt: doc.createdAt,
    encrypted: Boolean(doc.encrypted), forkedFromDocumentId: doc.forkedFrom || null,
  };
}
function remember(db, userId, documentId) {
  const row = db.access.find((item) => item.userId === userId && item.documentId === documentId);
  if (row) row.lastOpenedAt = nowIso();
  else db.access.push({ userId, documentId, lastOpenedAt: nowIso() });
}
async function findUserByEmail(email) {
  const db = await readDb();
  return db.users.find((user) => user.email === email) || null;
}
async function createUser(input) {
  let created = null;
  let duplicate = false;
  await updateDb((db) => {
    if (db.users.some((user) => user.email === input.email)) { duplicate = true; return db; }
    created = { id: crypto.randomUUID(), email: input.email, passwordHash: input.passwordHash, name: input.name, color: input.color, createdAt: nowIso() };
    db.users.push(created);
    return db;
  });
  return { user: created, duplicate };
}
async function listDocuments(userId) {
  const db = await readDb();
  const ids = new Set(db.access.filter((item) => item.userId === userId).map((item) => item.documentId));
  return db.documents.filter((doc) => ids.has(doc.id)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((doc) => mapDocument(doc, db, userId));
}
async function createDocument(user, input) {
  let doc = null;
  await updateDb((db) => {
    doc = { id: crypto.randomUUID(), title: input.title, icon: input.icon, ownerId: user.id, encrypted: input.encrypted, forkedFrom: null, state: input.state, createdAt: nowIso(), updatedAt: nowIso() };
    db.documents.push(doc);
    remember(db, user.id, doc.id);
    return db;
  });
  return mapDocument(doc, await readDb(), user.id);
}
async function getDocument(id, userId, track = true) {
  if (!track) {
    const db = await readDb();
    const doc = db.documents.find((item) => item.id === id);
    return doc ? { view: mapDocument(doc, db, userId) } : null;
  }
  let view = null;
  let missing = false;
  await updateDb((db) => {
    const doc = db.documents.find((item) => item.id === id);
    if (!doc) { missing = true; return db; }
    remember(db, userId, doc.id);
    view = mapDocument(doc, db, userId);
    return db;
  });
  return missing ? null : { view };
}
async function patchDocument(id, patch) {
  await updateDb((db) => {
    const doc = db.documents.find((item) => item.id === id);
    if (!doc) return db;
    if (patch.title) doc.title = patch.title;
    if (patch.icon) doc.icon = patch.icon;
    doc.updatedAt = nowIso();
    return db;
  });
}
async function deleteDocument(id) {
  await updateDb((db) => {
    db.documents = db.documents.filter((doc) => doc.id !== id);
    db.access = db.access.filter((item) => item.documentId !== id);
    db.pending = db.pending.filter((item) => item.documentId !== id);
    db.awareness = db.awareness.filter((item) => item.documentId !== id);
    db.signals = db.signals.filter((item) => item.documentId !== id);
    return db;
  });
}
async function forkDocument(id, user) {
  let created = null;
  let missing = false;
  await updateDb((db) => {
    const parent = db.documents.find((item) => item.id === id);
    if (!parent) { missing = true; return db; }
    created = { id: crypto.randomUUID(), title: `${parent.title} branch`.slice(0, 200), icon: parent.icon, ownerId: user.id, encrypted: parent.encrypted, forkedFrom: parent.id, state: parent.state, createdAt: nowIso(), updatedAt: nowIso() };
    db.documents.push(created);
    remember(db, user.id, created.id);
    return db;
  });
  if (missing || !created) return null;
  return mapDocument(created, await readDb(), user.id);
}
async function listBranches(id) {
  const db = await readDb();
  return db.documents.filter((doc) => doc.forkedFrom === id).map((doc) => ({ id: doc.id, title: doc.title, icon: doc.icon, createdAt: doc.createdAt }));
}
async function readState(id) {
  const db = await readDb();
  const doc = db.documents.find((item) => item.id === id);
  if (!doc) return null;
  const pending = doc.encrypted ? db.pending.filter((item) => item.documentId === id).map((item) => item.update) : [];
  return { encrypted: Boolean(doc.encrypted), baseline: doc.state || null, pending };
}
async function readSync(id, since) {
  const db = await readDb();
  const doc = db.documents.find((item) => item.id === id);
  if (!doc) return null;
  const cutoff = Date.now() - 30_000;
  return {
    title: doc.title, ownerId: doc.ownerId, encrypted: Boolean(doc.encrypted), state: doc.state || "",
    pending: doc.encrypted ? db.pending.filter((item) => item.documentId === id).map((item) => item.update) : [],
    awareness: db.awareness.filter((item) => item.documentId === id && Date.parse(item.updatedAt) > cutoff).map((item) => ({ clientId: item.clientId, update: item.update })),
    signals: db.signals.filter((item) => item.documentId === id && item.id > since).slice(-40).map((item) => ({ id: item.id, kind: item.kind, ...item.payload })),
  };
}
async function applySync(id, body) {
  let result = { ok: true };
  let missing = false;
  await updateDb((db) => {
    const doc = db.documents.find((item) => item.id === id);
    if (!doc) { missing = true; return db; }
    if (body.type === "update" && typeof body.update === "string") {
      if (doc.encrypted) db.pending.push({ documentId: id, update: body.update });
      else { doc.state = mergeState(doc.state, body.update); doc.updatedAt = nowIso(); }
      return db;
    }
    if (body.type === "checkpoint" && typeof body.state === "string") {
      doc.state = body.state;
      doc.updatedAt = nowIso();
      db.pending = db.pending.filter((item) => item.documentId !== id);
      return db;
    }
    if (body.type === "awareness" && body.clientId && typeof body.update === "string") {
      const clientId = String(body.clientId).slice(0, 40);
      const row = db.awareness.find((item) => item.documentId === id && item.clientId === clientId);
      if (row) { row.update = body.update; row.updatedAt = nowIso(); }
      else db.awareness.push({ documentId: id, clientId, update: body.update, updatedAt: nowIso() });
      return db;
    }
    if (body.type === "signal") {
      db.signalSeq += 1;
      const idNum = db.signalSeq;
      db.signals.push({ id: idNum, documentId: id, kind: String(body.kind || "signal").slice(0, 24), payload: { emoji: body.emoji || "", clientId: body.clientId || "", index: body.index, length: body.length } });
      db.signals = db.signals.filter((item) => item.documentId !== id || item.id > idNum - 80);
      result = { ok: true, id: idNum };
      return db;
    }
    const error = new Error("Unknown sync operation");
    error.status = 400;
    throw error;
  });
  if (missing) return null;
  return result;
}

async function register(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 40);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, "Enter a valid email");
  if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters");
  if (name.length < 1) return fail(res, 400, "Name is required");
  if (await findUserByEmail(email)) return fail(res, 409, "An account with that email already exists");
  const { user, duplicate } = await createUser({ email, passwordHash: await hashPassword(password), name, color: pickColor(email) });
  if (duplicate || !user) return fail(res, 409, "An account with that email already exists");
  return send(res, 201, { token: signToken(user), user: publicUser(user) });
}
async function login(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(String(body.password || ""), user.passwordHash))) return fail(res, 401, "Wrong email or password");
  return send(res, 200, { token: signToken(user), user: publicUser(user) });
}
async function me(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  return send(res, 200, { user: publicUser(user) });
}
async function documents(req, res) {
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  if (req.method === "GET") return send(res, 200, { documents: await listDocuments(user.id) });
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  const body = await readJson(req);
  const title = String(body.title || "Untitled").trim().slice(0, 200) || "Untitled";
  const icon = String(body.icon || "📄").slice(0, 8) || "📄";
  const encrypted = Boolean(body.encrypted);
  const state = encrypted ? String(body.initialState || "") : emptyState();
  if (encrypted && !state) return fail(res, 400, "Encrypted documents need an initial state");
  return send(res, 201, { document: await createDocument(user, { title, icon, encrypted, state }) });
}
async function documentById(req, res) {
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  const id = String(req.query?.id || "");
  const found = await getDocument(id, user.id, req.method === "GET");
  if (!found) return fail(res, 404, "Document not found");
  if (req.method === "GET") return send(res, 200, { document: found.view });
  if (req.method === "PATCH") {
    const body = await readJson(req);
    const patch = {};
    if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200);
    if (typeof body.icon === "string") patch.icon = body.icon.slice(0, 8);
    await patchDocument(id, patch);
    const next = await getDocument(id, user.id, false);
    return send(res, 200, { document: next.view });
  }
  if (req.method === "DELETE") {
    if (!found.view.isOwner) return fail(res, 403, "Only the owner can delete this document");
    await deleteDocument(id);
    return send(res, 200, { ok: true });
  }
  return fail(res, 405, "Method not allowed");
}
async function state(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  const found = await getDocument(String(req.query?.id || ""), user.id, false);
  if (!found) return fail(res, 404, "Document not found");
  return send(res, 200, await readState(String(req.query.id)));
}
async function branch(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  const id = String(req.query?.id || "");
  if (!(await getDocument(id, user.id, false))) return fail(res, 404, "Document not found");
  const document = await forkDocument(id, user);
  if (!document) return fail(res, 404, "Document not found");
  return send(res, 201, { document });
}
async function branches(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  const id = String(req.query?.id || "");
  if (!(await getDocument(id, user.id, false))) return fail(res, 404, "Document not found");
  return send(res, 200, { branches: await listBranches(id) });
}
function emptyList(req, res, key) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  if (!requireUser(req)) return fail(res, 401, "Sign in required");
  return send(res, 200, { [key]: [] });
}
async function sync(req, res) {
  const user = requireUser(req);
  if (!user) return fail(res, 401, "Sign in required");
  const id = String(req.query?.id || "");
  if (!(await getDocument(id, user.id, false))) return fail(res, 404, "Document not found");
  if (req.method === "GET") {
    const since = Number(req.query?.since || 0);
    return send(res, 200, await readSync(id, Number.isFinite(since) ? since : 0));
  }
  if (req.method === "POST") {
    const result = await applySync(id, await readJson(req));
    if (!result) return fail(res, 404, "Document not found");
    return send(res, 200, result);
  }
  return fail(res, 405, "Method not allowed");
}

function pathOf(req) {
  const raw = req.url || "/";
  try { return new URL(raw, "http://localhost").pathname.replace(/\/$/, "") || "/"; }
  catch { return String(raw).split("?")[0].replace(/\/$/, "") || "/"; }
}

export default async function handler(req, res) {
  try {
    const path = pathOf(req);
    const doc = path.match(/^\/api\/documents\/([^/]+)(?:\/(.*))?$/);
    const syncMatch = path.match(/^\/api\/sync\/([^/]+)$/);
    if (doc) req.query = { ...(req.query || {}), id: decodeURIComponent(doc[1]) };
    if (syncMatch) req.query = { ...(req.query || {}), id: decodeURIComponent(syncMatch[1]) };
    if (path === "/api/auth/register") return await register(req, res);
    if (path === "/api/auth/login") return await login(req, res);
    if (path === "/api/auth/me") return await me(req, res);
    if (path === "/api/documents") return await documents(req, res);
    if (doc && !doc[2]) return await documentById(req, res);
    if (doc && doc[2] === "state") return await state(req, res);
    if (doc && doc[2] === "branch") return await branch(req, res);
    if (doc && doc[2] === "branches") return await branches(req, res);
    if (doc && doc[2] === "history") return emptyList(req, res, "snapshots");
    if (doc && doc[2] === "timelapse") return emptyList(req, res, "frames");
    if (doc && doc[2] === "timelapse/updates") return emptyList(req, res, "updates");
    if (syncMatch) return await sync(req, res);
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not finish that request" });
  }
}
