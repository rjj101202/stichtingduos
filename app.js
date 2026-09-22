const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, getSetting, setSetting, stripHtml, reindexItem, removeFromIndex, hasFts, ensureFresh, persistDb, IS_VERCEL } = require('./lib/db');
const sessions = require('./lib/session');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

if (!IS_VERCEL) {
  // Lokaal serveert Express de statische bestanden; op Vercel doet het platform dat (map public/)
  app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), { maxAge: '7d' }));
  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d' }));
  app.use('/wp-content/uploads', express.static(path.join(__dirname, 'public', 'uploads'), { maxAge: '7d' }));
  app.use('/tinymce', express.static(path.join(__dirname, 'node_modules', 'tinymce'), { maxAge: '7d' }));
}

// Eenmalige initialisatie: zet de database vanaf een URL in Blob-opslag.
// Beveiligd met het SESSION_SECRET (alleen de beheerder van de omgeving kent dat).
// Staat vóór de ensureFresh-middleware zodat hij ook werkt als er nog geen database is.
app.post('/api/bootstrap-db', async (req, res) => {
  const auth = String(req.headers.authorization || '');
  if (!process.env.SESSION_SECRET || auth !== 'Bearer ' + process.env.SESSION_SECRET) {
    return res.status(401).json({ error: 'Niet toegestaan' });
  }
  const srcUrl = String((req.body && req.body.url) || '');
  if (!/^https:\/\//.test(srcUrl)) return res.status(400).json({ error: 'Ongeldige bron-URL' });
  try {
    const r = await fetch(srcUrl);
    if (!r.ok) throw new Error('Bron gaf HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    // sanity check: SQLite-bestanden beginnen met "SQLite format 3"
    if (buf.length < 100 || !buf.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) {
      throw new Error('Bestand is geen SQLite-database');
    }
    const { put } = require('@vercel/blob');
    const blob = await put('db/duos.db', buf, {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/octet-stream',
      cacheControlMaxAge: 60,
    });
    res.json({ ok: true, url: blob.url, bytes: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Database beschikbaar/actueel maken (downloadt op Vercel zo nodig de laatste versie uit Blob)
app.use(async (req, res, next) => {
  try { await ensureFresh(); next(); } catch (e) { next(e); }
});

app.use(sessions.middleware);

// ---------- Helpers ----------
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function getMenu() {
  try { return JSON.parse(getSetting('menu', '[]')); } catch (e) { return []; }
}

function catsForPost(postId) {
  return db.prepare(`SELECT c.* FROM categories c JOIN post_categories pc ON pc.category_id = c.id WHERE pc.post_id = ? ORDER BY c.name`).all(postId);
}

function attachCats(posts) {
  for (const p of posts) p.cats = catsForPost(p.id);
  return posts;
}

function searchContent(q, limit = 50) {
  q = String(q || '').trim();
  if (!q) return { posts: [], pages: [] };
  let hits = [];
  if (hasFts()) {
    try {
      const ftsq = q.split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '') + '"').join(' ');
      hits = db.prepare(`SELECT kind, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index) LIMIT ?`).all(ftsq, limit);
    } catch (e) { hits = []; }
  }
  if (!hits.length) {
    const like = '%' + q + '%';
    const posts = db.prepare(`SELECT 'post' AS kind, id AS ref_id FROM posts WHERE status='publish' AND (title LIKE ? OR content LIKE ?) ORDER BY date DESC LIMIT ?`).all(like, like, limit);
    const pages = db.prepare(`SELECT 'page' AS kind, id AS ref_id FROM pages WHERE status='publish' AND (title LIKE ? OR content LIKE ?) LIMIT ?`).all(like, like, limit);
    hits = [...pages, ...posts];
  }
  const posts = [], pages = [];
  for (const h of hits) {
    if (h.kind === 'post') {
      const p = db.prepare(`SELECT * FROM posts WHERE id = ? AND status='publish'`).get(h.ref_id);
      if (p) posts.push(p);
    } else {
      const p = db.prepare(`SELECT * FROM pages WHERE id = ? AND status='publish'`).get(h.ref_id);
      if (p) pages.push(p);
    }
  }
  return { posts: attachCats(posts), pages };
}

// Locals voor alle templates
app.use((req, res, next) => {
  res.locals.isAdmin = !!(req.auth && req.auth.userId);
  res.locals.adminName = (req.auth && req.auth.displayName) || '';
  res.locals.settings = {
    site_title: getSetting('site_title', 'Stichting DUOS'),
    site_tagline: getSetting('site_tagline', ''),
    logo: getSetting('logo', ''),
    donate_url: getSetting('donate_url', '/doneer-nu/'),
    forum_url: getSetting('forum_url', '#'),
    youtube_url: getSetting('youtube_url', '#'),
    newsletter_title: getSetting('newsletter_title', ''),
    newsletter_text: getSetting('newsletter_text', ''),
    newsletter_url: getSetting('newsletter_url', '/nieuwsbrief/'),
    footer_about: getSetting('footer_about', ''),
    footer_copyright: getSetting('footer_copyright', ''),
  };
  res.locals.menu = getMenu();
  res.locals.formatDate = formatDate;
  res.locals.currentPath = req.path;
  res.locals.searchQuery = '';
  next();
});

function requireAdmin(req, res, next) {
  if (req.auth && req.auth.userId) return next();
  return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
}

// ---------- Publieke routes ----------
app.get('/', (req, res) => {
  const featured = attachCats(db.prepare(`SELECT * FROM posts WHERE status='publish' ORDER BY date DESC LIMIT 9`).all());
  let slides = [];
  try { slides = JSON.parse(getSetting('hero_slides', '[]')); } catch (e) {}
  let stats = [];
  try { stats = JSON.parse(getSetting('home_stats', '[]')); } catch (e) {}
  const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS cnt FROM categories c WHERE c.slug IN ('prostaatkanker','blaaskanker','zaadbalkanker','nierkanker','patient','asco','news') ORDER BY cnt DESC`).all();
  res.render('home', {
    pageTitle: null,
    featured, slides, stats, cats,
    hero_title: getSetting('home_hero_title', ''),
    hero_text: getSetting('home_hero_text', ''),
    featured_title: getSetting('home_featured_title', 'Uitgelicht nieuws'),
    featured_text: getSetting('home_featured_text', ''),
  });
});

app.get('/zoeken', (req, res) => {
  const q = String(req.query.q || '').trim();
  const results = searchContent(q, 60);
  res.locals.searchQuery = q;
  res.render('search', { pageTitle: q ? `Zoeken: ${q}` : 'Zoeken', q, results });
});

function renderArchive(req, res, opts) {
  const perPage = 12;
  const page = Math.max(1, parseInt(req.params.page || '1', 10) || 1);
  const total = db.prepare(opts.countSql).get(...opts.params).n;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const posts = attachCats(db.prepare(opts.listSql).all(...opts.params, perPage, (page - 1) * perPage));
  res.render('archive', {
    pageTitle: opts.title,
    title: opts.title,
    description: opts.description || '',
    image: opts.image || '',
    posts, page, totalPages, total,
    baseUrl: opts.baseUrl,
  });
}

app.get(['/category/:slug', '/category/:slug/page/:page'], (req, res, next) => {
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!cat) return next();
  renderArchive(req, res, {
    title: cat.name,
    image: cat.image,
    countSql: `SELECT COUNT(*) AS n FROM posts p JOIN post_categories pc ON pc.post_id = p.id WHERE pc.category_id = ? AND p.status='publish'`,
    listSql: `SELECT p.* FROM posts p JOIN post_categories pc ON pc.post_id = p.id WHERE pc.category_id = ? AND p.status='publish' ORDER BY p.date DESC LIMIT ? OFFSET ?`,
    params: [cat.id],
    baseUrl: `/category/${cat.slug}`,
  });
});

app.get(['/tag/:slug', '/tag/:slug/page/:page'], (req, res, next) => {
  const tag = db.prepare('SELECT * FROM tags WHERE slug = ?').get(req.params.slug);
  if (!tag) return next();
  renderArchive(req, res, {
    title: `Onderwerp: ${tag.name}`,
    countSql: `SELECT COUNT(*) AS n FROM posts p JOIN post_tags pt ON pt.post_id = p.id WHERE pt.tag_id = ? AND p.status='publish'`,
    listSql: `SELECT p.* FROM posts p JOIN post_tags pt ON pt.post_id = p.id WHERE pt.tag_id = ? AND p.status='publish' ORDER BY p.date DESC LIMIT ? OFFSET ?`,
    params: [tag.id],
    baseUrl: `/tag/${tag.slug}`,
  });
});

app.get(['/nieuws', '/nieuws/page/:page'], (req, res) => {
  renderArchive(req, res, {
    title: 'Al het nieuws',
    countSql: `SELECT COUNT(*) AS n FROM posts WHERE status='publish'`,
    listSql: `SELECT * FROM posts WHERE status='publish' ORDER BY date DESC LIMIT ? OFFSET ?`,
    params: [],
    baseUrl: '/nieuws',
  });
});

// ---------- Media-opslag (lokaal: schijf, Vercel: Blob) ----------
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const upload = IS_VERCEL
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
  : multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
          const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '-');
          const exists = fs.existsSync(path.join(uploadsDir, safe));
          cb(null, exists ? Date.now() + '-' + safe : safe);
        },
      }),
      limits: { fileSize: 25 * 1024 * 1024 },
    });

async function storeUploadedFile(file) {
  if (!IS_VERCEL) return { url: '/uploads/' + file.filename, name: file.filename };
  const { put } = require('@vercel/blob');
  const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '-');
  const blob = await put('uploads/' + safe, file.buffer, {
    access: 'public',
    addRandomSuffix: true,
    contentType: file.mimetype || 'application/octet-stream',
  });
  return { url: blob.url, name: blob.pathname.replace(/^uploads\//, '') };
}

let uploadsManifest = null;
function repoUploads() {
  if (uploadsManifest) return uploadsManifest;
  try {
    uploadsManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'uploads-manifest.json'), 'utf-8'));
  } catch (e) { uploadsManifest = []; }
  return uploadsManifest;
}

// ---------- Admin ----------
app.get('/admin/login', (req, res) => {
  if (req.auth) return res.redirect('/admin');
  res.render('admin/login', { error: null, next: req.query.next || '/admin' });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).render('admin/login', { error: 'Onjuiste gebruikersnaam of wachtwoord.', next: req.body.next || '/admin' });
  }
  sessions.login(res, user);
  const nxt = String(req.body.next || '/admin');
  res.redirect(nxt.startsWith('/') ? nxt : '/admin');
});

app.post('/admin/logout', (req, res) => {
  sessions.logout(res);
  res.redirect('/');
});

app.get('/admin', requireAdmin, (req, res) => {
  const stats = {
    posts: db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
    pages: db.prepare('SELECT COUNT(*) AS n FROM pages').get().n,
    categories: db.prepare('SELECT COUNT(*) AS n FROM categories').get().n,
  };
  const recent = attachCats(db.prepare('SELECT * FROM posts ORDER BY date DESC LIMIT 8').all());
  res.render('admin/dashboard', { pageTitle: 'Dashboard', stats, recent, active: 'dashboard' });
});

// Posts beheren
app.get('/admin/posts', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const perPage = 25;
  let rows, total;
  if (q) {
    const like = '%' + q + '%';
    total = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title LIKE ? OR slug LIKE ?').get(like, like).n;
    rows = db.prepare('SELECT * FROM posts WHERE title LIKE ? OR slug LIKE ? ORDER BY date DESC LIMIT ? OFFSET ?').all(like, like, perPage, (page - 1) * perPage);
  } else {
    total = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    rows = db.prepare('SELECT * FROM posts ORDER BY date DESC LIMIT ? OFFSET ?').all(perPage, (page - 1) * perPage);
  }
  attachCats(rows);
  res.render('admin/posts', { pageTitle: 'Berichten', rows, q, page, totalPages: Math.max(1, Math.ceil(total / perPage)), total, active: 'posts' });
});

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/ç/g, 'c').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bericht';
}

function uniquePostSlug(base, excludeId = 0) {
  let slug = base, i = 2;
  while (db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, excludeId)) slug = `${base}-${i++}`;
  return slug;
}

app.get('/admin/posts/new', requireAdmin, (req, res) => {
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.render('admin/edit-post', {
    pageTitle: 'Nieuw bericht', active: 'posts',
    post: { id: 0, title: '', slug: '', content: '', excerpt: '', featured_image: '', status: 'publish', date: new Date().toISOString() },
    postCats: [], cats,
  });
});

app.get('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/admin/posts');
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const postCats = catsForPost(post.id).map(c => c.id);
  res.render('admin/edit-post', { pageTitle: 'Bericht bewerken', active: 'posts', post, postCats, cats });
});

app.post('/admin/posts/save', requireAdmin, async (req, res) => {
  const id = parseInt(req.body.id || '0', 10) || 0;
  const title = String(req.body.title || '').trim() || '(zonder titel)';
  const content = String(req.body.content || '');
  let excerpt = String(req.body.excerpt || '').trim();
  if (!excerpt) excerpt = stripHtml(content).slice(0, 220) + '…';
  const featured = String(req.body.featured_image || '').trim();
  const status = req.body.status === 'draft' ? 'draft' : 'publish';
  let catIds = req.body.categories || [];
  if (!Array.isArray(catIds)) catIds = [catIds];
  catIds = catIds.map(Number).filter(Boolean);

  let postId = id;
  if (id) {
    const slugInput = String(req.body.slug || '').trim();
    const slug = uniquePostSlug(slugInput ? slugify(slugInput) : slugify(title), id);
    db.prepare(`UPDATE posts SET title=?, slug=?, content=?, excerpt=?, featured_image=?, status=?, modified=datetime('now') WHERE id=?`)
      .run(title, slug, content, excerpt, featured, status, id);
  } else {
    const slug = uniquePostSlug(slugify(String(req.body.slug || '').trim() || title));
    const maxId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM posts').get().m;
    postId = maxId + 1;
    db.prepare(`INSERT INTO posts (id, slug, title, content, excerpt, date, modified, featured_image, status) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)`)
      .run(postId, slug, title, content, excerpt, featured, status);
  }
  db.prepare('DELETE FROM post_categories WHERE post_id = ?').run(postId);
  const ins = db.prepare('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)');
  for (const cid of catIds) ins.run(postId, cid);
  reindexItem('post', postId, title, content);
  await persistDb();
  res.redirect('/admin/posts/' + postId + '/edit?saved=1');
});

app.post('/admin/posts/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  db.prepare('DELETE FROM post_categories WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(id);
  removeFromIndex('post', id);
  await persistDb();
  res.redirect('/admin/posts');
});

// Pagina's beheren
app.get('/admin/pages', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    const like = '%' + q + '%';
    rows = db.prepare('SELECT id, slug, path, title, updated_at FROM pages WHERE title LIKE ? OR path LIKE ? ORDER BY path').all(like, like);
  } else {
    rows = db.prepare('SELECT id, slug, path, title, updated_at FROM pages ORDER BY path').all();
  }
  res.render('admin/pages', { pageTitle: "Pagina's", rows, q, active: 'pages' });
});

app.get('/admin/pages/new', requireAdmin, (req, res) => {
  res.render('admin/edit-page', { pageTitle: 'Nieuwe pagina', active: 'pages', page: { id: 0, title: '', path: '', content: '' } });
});

app.get('/admin/pages/:id/edit', requireAdmin, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.redirect('/admin/pages');
  res.render('admin/edit-page', { pageTitle: 'Pagina bewerken', active: 'pages', page });
});

app.post('/admin/pages/save', requireAdmin, async (req, res) => {
  const id = parseInt(req.body.id || '0', 10) || 0;
  const title = String(req.body.title || '').trim() || '(zonder titel)';
  const content = String(req.body.content || '');
  let pagePath = String(req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!pagePath) pagePath = slugify(title);
  let pageId = id;
  if (id) {
    db.prepare(`UPDATE pages SET title=?, path=?, slug=?, content=?, updated_at=datetime('now') WHERE id=?`)
      .run(title, pagePath, pagePath.split('/').pop(), content, id);
  } else {
    const maxId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM pages').get().m;
    pageId = maxId + 1;
    db.prepare(`INSERT INTO pages (id, slug, path, title, content, excerpt, parent, menu_order, status, updated_at) VALUES (?, ?, ?, ?, ?, '', 0, 0, 'publish', datetime('now'))`)
      .run(pageId, pagePath.split('/').pop(), pagePath, title, content);
  }
  reindexItem('page', pageId, title, content);
  await persistDb();
  res.redirect('/admin/pages/' + pageId + '/edit?saved=1');
});

app.post('/admin/pages/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  removeFromIndex('page', id);
  await persistDb();
  res.redirect('/admin/pages');
});

// Media
app.get('/admin/media', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let files = [];
  if (IS_VERCEL) {
    files = repoUploads().map(f => ({ name: f, url: '/uploads/' + f, mtime: 0, isImage: /\.(jpe?g|png|gif|webp|svg)$/i.test(f) }));
    try {
      const { list } = require('@vercel/blob');
      let cursor;
      do {
        const page = await list({ prefix: 'uploads/', limit: 1000, cursor });
        for (const b of page.blobs) {
          const name = b.pathname.replace(/^uploads\//, '');
          files.push({ name, url: b.url, mtime: new Date(b.uploadedAt).getTime(), isImage: /\.(jpe?g|png|gif|webp|svg)$/i.test(name) });
        }
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
    } catch (e) { console.error('blob list:', e.message); }
  } else {
    files = fs.readdirSync(uploadsDir)
      .filter(f => fs.statSync(path.join(uploadsDir, f)).isFile())
      .map(f => ({ name: f, url: '/uploads/' + f, mtime: fs.statSync(path.join(uploadsDir, f)).mtimeMs, isImage: /\.(jpe?g|png|gif|webp|svg)$/i.test(f) }));
  }
  if (q) files = files.filter(f => f.name.toLowerCase().includes(q));
  files.sort((a, b) => b.mtime - a.mtime);
  res.render('admin/media', { pageTitle: 'Media', files: files.slice(0, 200), total: files.length, q, active: 'media' });
});

app.post('/admin/media/upload', requireAdmin, upload.array('files', 20), async (req, res) => {
  const stored = [];
  for (const f of req.files || []) stored.push(await storeUploadedFile(f));
  if (req.query.json || (req.headers.accept || '').includes('application/json')) {
    return res.json({ files: stored });
  }
  res.redirect('/admin/media');
});

// TinyMCE afbeelding-upload endpoint
app.post('/admin/media/tinymce', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand' });
  const stored = await storeUploadedFile(req.file);
  res.json({ location: stored.url });
});

// Instellingen
const EDITABLE_SETTINGS = ['site_title', 'site_tagline', 'logo', 'donate_url', 'forum_url', 'youtube_url',
  'home_hero_title', 'home_hero_text', 'home_featured_title', 'home_featured_text', 'home_stats',
  'newsletter_title', 'newsletter_text', 'newsletter_url', 'footer_about', 'footer_copyright', 'menu', 'hero_slides'];

app.get('/admin/settings', requireAdmin, (req, res) => {
  const values = {};
  for (const k of EDITABLE_SETTINGS) values[k] = getSetting(k, '');
  res.render('admin/settings', { pageTitle: 'Instellingen', values, saved: req.query.saved, error: null, active: 'settings' });
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  for (const k of EDITABLE_SETTINGS) {
    if (typeof req.body[k] === 'string') {
      if (['menu', 'hero_slides', 'home_stats'].includes(k)) {
        try { JSON.parse(req.body[k]); } catch (e) {
          const values = {};
          for (const kk of EDITABLE_SETTINGS) values[kk] = typeof req.body[kk] === 'string' ? req.body[kk] : getSetting(kk, '');
          return res.status(400).render('admin/settings', { pageTitle: 'Instellingen', values, saved: false, error: `Ongeldige JSON in veld "${k}": ${e.message}`, active: 'settings' });
        }
      }
      setSetting(k, req.body[k]);
    }
  }
  await persistDb();
  res.redirect('/admin/settings?saved=1');
});

// Wachtwoord wijzigen
app.get('/admin/password', requireAdmin, (req, res) => {
  res.render('admin/password', { pageTitle: 'Wachtwoord wijzigen', error: null, saved: req.query.saved, active: 'password' });
});

app.post('/admin/password', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  if (!user || !bcrypt.compareSync(String(req.body.current || ''), user.password_hash)) {
    return res.status(400).render('admin/password', { pageTitle: 'Wachtwoord wijzigen', error: 'Huidig wachtwoord is onjuist.', saved: false, active: 'password' });
  }
  const nw = String(req.body.password || '');
  if (nw.length < 8) {
    return res.status(400).render('admin/password', { pageTitle: 'Wachtwoord wijzigen', error: 'Nieuw wachtwoord moet minimaal 8 tekens zijn.', saved: false, active: 'password' });
  }
  if (nw !== String(req.body.confirm || '')) {
    return res.status(400).render('admin/password', { pageTitle: 'Wachtwoord wijzigen', error: 'Wachtwoorden komen niet overeen.', saved: false, active: 'password' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nw, 10), user.id);
  await persistDb();
  res.redirect('/admin/password?saved=1');
});

// Inline bewerken vanaf de website zelf
app.post('/admin/api/inline-save', requireAdmin, async (req, res) => {
  const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
  const results = [];
  for (const ch of changes) {
    const [type, id, field] = String(ch.key || '').split(':');
    const value = String(ch.value ?? '');
    try {
      if (type === 'post' && ['title', 'content', 'excerpt'].includes(field)) {
        if (field === 'title') db.prepare(`UPDATE posts SET title = ?, modified = datetime('now') WHERE id = ?`).run(stripHtml(value), id);
        else db.prepare(`UPDATE posts SET ${field} = ?, modified = datetime('now') WHERE id = ?`).run(value, id);
        const p = db.prepare('SELECT title, content FROM posts WHERE id = ?').get(id);
        if (p) reindexItem('post', id, p.title, p.content);
        results.push({ key: ch.key, ok: true });
      } else if (type === 'page' && ['title', 'content'].includes(field)) {
        if (field === 'title') db.prepare(`UPDATE pages SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(stripHtml(value), id);
        else db.prepare(`UPDATE pages SET content = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
        const p = db.prepare('SELECT title, content FROM pages WHERE id = ?').get(id);
        if (p) reindexItem('page', id, p.title, p.content);
        results.push({ key: ch.key, ok: true });
      } else if (type === 'setting') {
        const key = id;
        if (EDITABLE_SETTINGS.includes(key)) {
          setSetting(key, field === 'text' ? stripHtml(value) : value);
          results.push({ key: ch.key, ok: true });
        } else {
          results.push({ key: ch.key, ok: false, error: 'Onbekende instelling' });
        }
      } else {
        results.push({ key: ch.key, ok: false, error: 'Onbekend type' });
      }
    } catch (e) {
      results.push({ key: ch.key, ok: false, error: e.message });
    }
  }
  await persistDb();
  res.json({ ok: results.every(r => r.ok), results });
});

// ---------- Blogposts (catch-all: eerst post-slug, dan pagina-pad) ----------
app.get(/.*/, (req, res, next) => {
  const clean = decodeURIComponent(req.path).replace(/^\/+|\/+$/g, '');
  if (!clean || clean.startsWith('admin') || clean.startsWith('uploads') || clean.startsWith('assets') || clean.startsWith('api/')) return next();

  // Post op /slug/
  if (!clean.includes('/')) {
    const post = db.prepare(`SELECT * FROM posts WHERE slug = ?`).get(clean);
    if (post && (post.status === 'publish' || res.locals.isAdmin)) {
      attachCats([post]);
      const catIds = post.cats.map(c => c.id);
      let related = [];
      if (catIds.length) {
        related = attachCats(db.prepare(`SELECT DISTINCT p.* FROM posts p JOIN post_categories pc ON pc.post_id = p.id
          WHERE pc.category_id IN (${catIds.map(() => '?').join(',')}) AND p.id != ? AND p.status='publish'
          ORDER BY p.date DESC LIMIT 3`).all(...catIds, post.id));
      }
      const prev = db.prepare(`SELECT slug, title FROM posts WHERE date < ? AND status='publish' ORDER BY date DESC LIMIT 1`).get(post.date);
      const nextP = db.prepare(`SELECT slug, title FROM posts WHERE date > ? AND status='publish' ORDER BY date ASC LIMIT 1`).get(post.date);
      return res.render('post', { pageTitle: post.title, post, related, prev, nextP });
    }
  }

  // Pagina op pad (ook genest)
  const page = db.prepare(`SELECT * FROM pages WHERE path = ? AND status='publish'`).get(clean);
  if (page) {
    const children = db.prepare('SELECT slug, path, title, excerpt FROM pages WHERE parent = ? ORDER BY menu_order, title').all(page.id);
    const crumbs = [];
    let cur = page;
    while (cur && cur.parent) {
      cur = db.prepare('SELECT id, path, title, parent FROM pages WHERE id = ?').get(cur.parent);
      if (cur) crumbs.unshift(cur);
    }
    return res.render('page', { pageTitle: page.title, page, children, crumbs });
  }

  next();
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { pageTitle: 'Pagina niet gevonden' });
});

module.exports = app;
