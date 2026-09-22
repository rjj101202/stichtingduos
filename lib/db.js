/*
 * Databaselaag.
 *
 * Lokaal:  data/duos.db (gewoon een bestand).
 * Vercel:  het bestand is niet persistent; de bron van waarheid staat in
 *          Vercel Blob (pad db/duos.db). Bij een cold start wordt de database
 *          naar /tmp gedownload; na elke schrijfactie wordt hij teruggezet.
 *          ensureFresh() controleert periodiek of een andere instance een
 *          nieuwere versie heeft geüpload en herlaadt dan.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_DB_PATH = 'db/duos.db';
const FRESH_INTERVAL_MS = 15000;

const localDbPath = IS_VERCEL
  ? path.join('/tmp', 'duos.db')
  : path.join(__dirname, '..', 'data', 'duos.db');

let conn = null;
let knownUploadedAt = null;
let lastFreshCheck = 0;

function blobModule() {
  return require('@vercel/blob');
}

function openConn() {
  conn = new Database(localDbPath);
  conn.pragma('journal_mode = WAL');
  ensureSchema(conn);
}

function closeConn() {
  if (conn) { try { conn.close(); } catch (e) {} conn = null; }
}

async function downloadDb() {
  const url = process.env.DUOS_DB_URL;
  if (!url) throw new Error('DUOS_DB_URL ontbreekt (URL van de database in Vercel Blob)');
  const { head } = blobModule();
  const meta = await head(url);
  const busted = meta.downloadUrl + (meta.downloadUrl.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(meta.uploadedAt);
  const res = await fetch(busted);
  if (!res.ok) throw new Error('Database downloaden mislukt: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  closeConn();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(localDbPath + suffix, { force: true }); } catch (e) {}
  }
  fs.writeFileSync(localDbPath, buf);
  knownUploadedAt = String(meta.uploadedAt);
  openConn();
}

/**
 * Zorgt dat er een verbinding is en (op Vercel) dat de lokale kopie
 * niet verouderd is. Aanroepen aan het begin van elke request.
 */
async function ensureFresh() {
  if (!IS_VERCEL) {
    if (!conn) openConn();
    return;
  }
  const now = Date.now();
  if (conn && now - lastFreshCheck < FRESH_INTERVAL_MS) return;
  lastFreshCheck = now;
  if (!conn) {
    await downloadDb();
    return;
  }
  try {
    const { head } = blobModule();
    const meta = await head(process.env.DUOS_DB_URL);
    if (String(meta.uploadedAt) !== knownUploadedAt) await downloadDb();
  } catch (e) {
    // Bij een tijdelijke fout blijven we de lokale kopie gebruiken
    console.error('ensureFresh:', e.message);
  }
}

/**
 * Slaat de database terug op naar Vercel Blob. Aanroepen na elke
 * schrijfactie in het beheer. Lokaal is dit een no-op.
 */
async function persistDb() {
  if (!IS_VERCEL) return;
  if (!conn) return;
  conn.pragma('wal_checkpoint(TRUNCATE)');
  const buf = fs.readFileSync(localDbPath);
  const { put, head } = blobModule();
  await put(BLOB_DB_PATH, buf, {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 60,
  });
  try {
    const meta = await head(process.env.DUOS_DB_URL);
    knownUploadedAt = String(meta.uploadedAt);
    lastFreshCheck = Date.now();
  } catch (e) {}
}

function ensureSchema(c) {
  c.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  parent INTEGER NOT NULL DEFAULT 0,
  menu_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'publish',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  modified TEXT NOT NULL,
  featured_image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'publish'
);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date DESC);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS post_categories (
  post_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_cat ON post_categories(category_id);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);
  try {
    c.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        kind, ref_id, title, body, tokenize='unicode61 remove_diacritics 2'
      );
    `);
  } catch (e) { /* zonder FTS5 valt zoeken terug op LIKE */ }
}

// Lokaal direct openen zodat scripts (import.js) zonder ensureFresh werken
if (!IS_VERCEL) {
  const dataDir = path.dirname(localDbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  openConn();
}

// Proxy zodat bestaande code `db.prepare(...)` kan blijven gebruiken,
// ook nadat de verbinding is ververst.
const db = new Proxy({}, {
  get(_, prop) {
    if (!conn) {
      if (IS_VERCEL) throw new Error('Database nog niet geladen — ensureFresh() vergeten?');
      openConn();
    }
    const v = conn[prop];
    return typeof v === 'function' ? v.bind(conn) : v;
  },
});

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#8216;/g, '‘').replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasFts() {
  try {
    db.prepare("SELECT 1 FROM search_index LIMIT 1").get();
    return true;
  } catch (e) { return false; }
}

function reindexItem(kind, refId, title, contentHtml) {
  if (!hasFts()) return;
  db.prepare("DELETE FROM search_index WHERE kind = ? AND ref_id = ?").run(kind, String(refId));
  db.prepare("INSERT INTO search_index (kind, ref_id, title, body) VALUES (?, ?, ?, ?)")
    .run(kind, String(refId), stripHtml(title), stripHtml(contentHtml));
}

function removeFromIndex(kind, refId) {
  if (!hasFts()) return;
  db.prepare("DELETE FROM search_index WHERE kind = ? AND ref_id = ?").run(kind, String(refId));
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = {
  db, getSetting, setSetting, stripHtml, reindexItem, removeFromIndex, hasFts,
  ensureFresh, persistDb, IS_VERCEL,
};
