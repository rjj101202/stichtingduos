/*
 * Importeert de gescrapete WordPress-content (_scrape/*.json) in data/duos.db
 * Draaien met: npm run import
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, setSetting, stripHtml, reindexItem } = require('../lib/db');

const SCRAPE = path.join(__dirname, '..', '_scrape');

function loadJson(file) {
  const p = path.join(SCRAPE, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadSeries(prefix) {
  const out = [];
  for (let i = 1; i <= 30; i++) {
    const d = loadJson(`${prefix}-${i}.json`);
    if (!d || !Array.isArray(d)) continue;
    out.push(...d);
  }
  return out;
}

function rewriteUrls(html) {
  return String(html || '')
    .replace(/https?:\/\/(www\.)?stichtingduos\.nl\/wp-content\/uploads\//g, '/uploads/')
    .replace(/https?:\/\/(www\.)?stichtingduos\.nl\//g, '/');
}

function cleanExcerpt(rendered) {
  let t = stripHtml(rendered || '');
  t = t.replace(/\s*\[(\.\.\.|&hellip;|…)\]\s*$/, '…').replace(/\[…\]\s*$/, '…');
  return t;
}

function pathFromLink(link) {
  return String(link || '')
    .replace(/^https?:\/\/(www\.)?stichtingduos\.nl/, '')
    .replace(/^\/+|\/+$/g, '');
}

console.log('Laden van gescrapete data...');
const pages = loadSeries('pages');
const posts = loadSeries('posts');
const categories = loadJson('categories.json') || [];
const tags = loadSeries('tags');
const featuredMedia = loadJson('featured-media.json') || [];
const slides = loadJson('slides.json') || [];

console.log(`pagina's: ${pages.length}, posts: ${posts.length}, categorieën: ${categories.length}, tags: ${tags.length}`);

const mediaMap = {};
for (const m of featuredMedia) mediaMap[m.id] = rewriteUrls(m.source_url);

// Nette namen voor categorieën zoals op de huidige site gebruikt
const catNameOverrides = {
  news: 'Actueel uro-oncologie',
  patient: 'Patiëntenervaringen',
  asco: 'ASCO/ESMO',
  'stichting-duos': 'Stichting DUOS',
  'vragen-van-patienten': 'Vragen van patiënten',
};
const catImages = {
  news: '/uploads/Actueel-nieuws-uro-oncologie-400-e1641905505232.png',
  zaadbalkanker: '/uploads/zaadbalkanker795x800.jpg',
  asco: '/uploads/site-Esmo-Asco-jpeg-grijze-achtergrond.jpg',
  'stichting-duos': '/uploads/site-Nieuws-stichting-Duos-800-bij-450.jpg',
  nierkanker: '/uploads/nierkanker-beeld-800x-1.jpg',
  patient: '/uploads/patientenervaring800x379-stock.jpg',
  prostaatkanker: '/uploads/prostaatkanker1000x677.jpg',
  blaaskanker: '/uploads/blaas800x600-stock.jpg',
  'vragen-van-patienten': '/uploads/cat-patientenvraag.jpg',
  featured: '/uploads/Actueel-nieuws-uro-oncologie-400-e1641905505232.png',
};

const knownPaths = new Set();
for (const p of pages) {
  const pt = pathFromLink(p.link);
  if (pt) knownPaths.add(pt);
}
for (const p of posts) knownPaths.add(p.slug);
for (const c of categories) knownPaths.add('category/' + c.slug);
for (const t of tags) knownPaths.add('tag/' + t.slug);

// Verwijder links naar interne pagina's die niet meer bestaan (bijv. bijlage-pagina's):
// behoud de inhoud van de link, verwijder alleen de <a>-wrapper.
function unwrapDeadLinks(html) {
  return String(html || '').replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const m = /href="([^"]*)"/i.exec(attrs);
    if (!m) return full;
    const href = m[1];
    if (/^(https?:)?\/\//i.test(href) || /^(mailto:|tel:|#)/i.test(href)) return full; // extern of anker
    if (href.startsWith('/uploads/') || href.startsWith('/wp-content/')) return full; // bestand
    const clean = href.replace(/^\/+|\/+$/g, '').split(/[?#]/)[0];
    if (!clean) return full;
    if (knownPaths.has(clean)) return full;
    if (clean.startsWith('category/') || clean.startsWith('tag/')) return full;
    return inner; // interne link naar onbekende pagina -> unwrap
  });
}

const tx = db.transaction(() => {
  db.exec('DELETE FROM pages; DELETE FROM posts; DELETE FROM categories; DELETE FROM post_categories; DELETE FROM tags; DELETE FROM post_tags;');
  try { db.exec('DELETE FROM search_index;'); } catch (e) {}

  const insCat = db.prepare('INSERT INTO categories (id, slug, name, parent, image) VALUES (?, ?, ?, ?, ?)');
  for (const c of categories) {
    insCat.run(c.id, c.slug, catNameOverrides[c.slug] || c.name, c.parent || 0, catImages[c.slug] || '');
  }

  const insTag = db.prepare('INSERT OR IGNORE INTO tags (id, slug, name) VALUES (?, ?, ?)');
  for (const t of tags) insTag.run(t.id, t.slug, t.name);

  const insPage = db.prepare(`INSERT INTO pages (id, slug, path, title, content, excerpt, parent, menu_order, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'publish', datetime('now'))`);
  let pageCount = 0;
  for (const p of pages) {
    const pt = pathFromLink(p.link);
    if (!pt) continue; // homepage wordt apart opgebouwd
    const content = unwrapDeadLinks(rewriteUrls(p.content && p.content.rendered));
    const title = stripHtml(p.title && p.title.rendered);
    insPage.run(p.id, p.slug, pt, title, content, cleanExcerpt(p.excerpt && p.excerpt.rendered), p.parent || 0, p.menu_order || 0);
    reindexItem('page', p.id, title, content);
    pageCount++;
  }

  const insPost = db.prepare(`INSERT INTO posts (id, slug, title, content, excerpt, date, modified, featured_image, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'publish')`);
  const insPC = db.prepare('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)');
  const insPT = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
  const catById = {};
  for (const c of categories) catById[c.id] = c;

  let postCount = 0;
  for (const p of posts) {
    const content = unwrapDeadLinks(rewriteUrls(p.content && p.content.rendered));
    const title = stripHtml(p.title && p.title.rendered);
    let img = mediaMap[p.featured_media] || '';
    if (!img) {
      const m = /<img[^>]*src="([^"]+)"/i.exec(content);
      if (m) img = m[1];
    }
    if (!img && Array.isArray(p.categories)) {
      for (const cid of p.categories) {
        const c = catById[cid];
        if (c && catImages[c.slug]) { img = catImages[c.slug]; break; }
      }
    }
    insPost.run(p.id, p.slug, title, content, cleanExcerpt(p.excerpt && p.excerpt.rendered), p.date, p.modified || p.date, img);
    if (Array.isArray(p.categories)) for (const cid of p.categories) insPC.run(p.id, cid);
    if (Array.isArray(p.tags)) for (const tid of p.tags) insPT.run(p.id, tid);
    reindexItem('post', p.id, title, content);
    postCount++;
  }

  console.log(`Geïmporteerd: ${pageCount} pagina's, ${postCount} posts`);
});
tx();

// ---------- Instellingen ----------
const menu = [
  { label: 'Home', url: '/' },
  { label: 'Stichting DUOS', url: '/over-stichting-duos/', children: [
    { label: 'Over Stichting DUOS', url: '/over-stichting-duos/' },
    { label: 'Foundation DUOS (English)', url: '/foundation-dutch-uro-oncology-studygroup-duos/' },
    { label: 'Deelnemen aan onderzoek', url: '/deelnemen-aan-onderzoek/' },
    { label: 'Veelgestelde vragen', url: '/veelgestelde-vragen/' },
    { label: 'Nieuwsbrief', url: '/nieuwsbrief/' },
    { label: 'Ziekenhuizen DUOS', url: '/ziekenhuizen-duos/' },
    { label: 'Contact', url: '/contact-stichting-duos/' },
  ]},
  { label: 'Voor patiënten', url: '#', children: [
    { label: 'Prostaatkanker', url: '/prostaatkanker/' },
    { label: 'Prostaatkanker: de behandelingen', url: '/prostaatkanker-de-behandelingen/' },
    { label: 'Blaaskanker', url: '/blaaskanker/' },
    { label: 'Blaaskanker: de behandelingen', url: '/blaaskanker-de-behandelingen-stichting-duos/' },
    { label: 'Nierkanker', url: '/nierkanker/' },
    { label: 'Zaadbalkanker', url: '/zaadbalkanker/' },
    { label: 'Patiëntenervaringen', url: '/category/patient/' },
    { label: 'Radiotherapie', url: '/radiotherapie-2/' },
    { label: 'Chemotherapie', url: '/chemotherapie/' },
    { label: 'Immunotherapie', url: '/immunotherapie/' },
    { label: 'Ondersteuning', url: '/ondersteuning/' },
  ]},
  { label: 'Studies', url: '/studies-uro-oncologie/', children: [
    { label: 'Studies uro-oncologie', url: '/studies-uro-oncologie/' },
    { label: 'Ziekenhuizen DUOS', url: '/ziekenhuizen-duos/' },
    { label: 'Prostaatkankerstudies', url: '/prostaatkankerstudies/', children: [
      { label: 'PERYTON (BRPC, 2de lijn)', url: '/peryton-mcrpc-2de-lijn/' },
      { label: 'DAROTAXEL (mCRPC, 2de lijn)', url: '/darotaxel-mcrpc-2de-lijn/' },
      { label: 'APA/ENZA Short (mHSPC, 1e lijn)', url: '/apa-enza-short-mhspc-1e-lijn/' },
      { label: 'OMAHA/MK56 (mCRPC, 2de lijn)', url: '/omaha-mk56-mcrpc-2de-lijn/' },
      { label: 'IDeate-Prostate01 (mCRPC, 1e lijn)', url: '/ideate-prostate01-mcrpc-1e-lijn/' },
      { label: 'Proactive-B (mCRPC, 2de lijn)', url: '/proactive-b-mcrpc-2de-lijn/' },
      { label: 'KLK-2 ComPAS (mCPRC, 2de lijn)', url: '/klk-2-compas-mcprc-2de-lijn/' },
    ]},
    { label: 'Blaaskankerstudies', url: '/blaaskankerstudies/', children: [
      { label: 'BladParadigm (blaas, diagnostiek)', url: '/bladparadigm-blaas-diagnostiek/' },
      { label: 'Precise 2 (blaas, diagnostiek)', url: '/precise-2-blaas-diagnostiek/' },
      { label: 'INTerpath-011 (blaas, 2de lijn)', url: '/interpath-011-blaas-2de-lijn/' },
      { label: 'MoonRISE-3 (niet-spierinvasief, 2de lijn)', url: '/moonrise-3-niet-spierinvasieve-blaas-2de-lijn/' },
      { label: 'TroFuse-031 (blaas, 2de/3de lijn)', url: '/trofuse-031-blaas-2de-of-3de-lijn/' },
    ]},
    { label: 'Studies zeldzame tumoren', url: '/studies-zeldzame-tumoren/', children: [
      { label: 'PRIAM (penis, inductie)', url: '/priam-penis-inductie/' },
    ]},
    { label: 'Recent gesloten studies', url: '/recent-gesloten-studies/', children: [
      { label: 'CHASIT (gesloten)', url: '/chasit-neo-adjuvant/' },
      { label: 'KN-365 (mCRPC, gesloten)', url: '/kn-365-mcrpc-2e-lijn/' },
      { label: 'PSMA-select (gesloten)', url: '/psma-select-mcrpc-1e-lijn/' },
      { label: 'SGNDV-001 (gesloten)', url: '/sgndv-001-blaas-1e-lijn/' },
      { label: 'AVE-Short (gesloten)', url: '/ave-short-blaas-1e-lijn/' },
      { label: 'KEYNOTE 676 (gesloten)', url: '/keynote-676-blaas-2de-lijn/' },
      { label: 'PET-MaN (gesloten)', url: '/pet-man-mhspc-1elijn/' },
      { label: 'Keynote-992 (gesloten)', url: '/keynote-992-blaas-2de-lijn/' },
      { label: 'DORA (gesloten)', url: '/dora-docetaxel-radium223-mcprc-2de-lijn/' },
    ]},
  ]},
  { label: 'Actueel', url: '/category/news/', children: [
    { label: 'Nieuwsarchief', url: '/category/news/' },
    { label: 'ASCO/ESMO', url: '/category/asco/' },
    { label: 'Patiëntenervaringen', url: '/category/patient/' },
    { label: 'Vragen van patiënten', url: '/category/vragen-van-patienten/' },
    { label: 'Nieuwsbrief', url: '/nieuwsbrief/' },
  ]},
  { label: 'Forums', url: 'https://forum.stichtingduos.nl/' },
  { label: 'Doneren', url: '/doneren/', children: [
    { label: 'Wat gebeurt er met uw donatie?', url: '/wat-gebeurt-er-met-uw-donatie/' },
    { label: 'Fiscaalvriendelijk doneren via ANBI', url: '/fiscaalvriendelijk-doneren-via-anbi/' },
    { label: 'Doneer nu', url: '/doneer-nu/' },
  ]},
  { label: 'Contact', url: '/contact-stichting-duos/' },
];

const heroSlides = slides.map(s => ({
  image: rewriteUrls(s.image),
  link: rewriteUrls((s.link || '').replace(/&#0?38;/g, '&')),
  alt: s.alt || '',
}));

const defaults = {
  site_title: 'Stichting DUOS',
  site_tagline: 'Dutch Uro-Oncology Studygroup',
  logo: '/uploads/logo250-e1556274175728.png',
  donate_url: '/doneer-nu/',
  forum_url: 'https://forum.stichtingduos.nl/',
  youtube_url: 'https://www.youtube.com/channel/UC9Xb6zznI3q5FWZUjhN3bEw',
  menu: JSON.stringify(menu, null, 1),
  hero_slides: JSON.stringify(heroSlides, null, 1),
  home_hero_title: 'Samen sterk in onderzoek naar urologische kanker',
  home_hero_text: 'Stichting DUOS (Dutch Uro-Oncology Studygroup) is de Nederlandse multidisciplinaire studiegroep van 27 aangesloten ziekenhuizen voor studies bij prostaatkanker, blaaskanker, nierkanker en zaadbalkanker.',
  home_featured_title: 'Uitgelicht nieuws',
  home_featured_text: 'Het laatste nieuws over uro-oncologie, studies en patiëntenervaringen.',
  home_stats: JSON.stringify([
    { value: '27', label: 'aangesloten ziekenhuizen' },
    { value: '2011', label: 'opgericht door prof. dr. Ronald de Wit' },
    { value: 'ANBI', label: 'erkend goed doel sinds 2013' },
    { value: '60+', label: 'studies uro-oncologie' },
  ], null, 1),
  newsletter_title: 'DUOS Nieuwsbrief',
  newsletter_text: 'Schrijf u in voor de wekelijkse DUOS nieuwsbrief met informatie over de (inter-)nationale ontwikkelingen en studies op het gebied van uro-oncologische tumoren.',
  newsletter_url: '/nieuwsbrief/',
  footer_about: 'Stichting DUOS (Dutch Uro-Oncology Studygroup) is de Nederlandse multidisciplinaire studiegroep voor studies bij prostaatkanker, blaaskanker, nierkanker en zaadbalkanker. DUOS is een erkende ANBI (Algemeen Nut Beogende Instelling).',
  footer_copyright: `Copyright ${new Date().getFullYear()} © Stichting DUOS`,
};
for (const [k, v] of Object.entries(defaults)) setSetting(k, v);

// ---------- Admin-gebruiker ----------
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existing) {
  const hash = bcrypt.hashSync('duos2026', 10);
  db.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)')
    .run('admin', hash, 'Beheerder');
  console.log('Admin-gebruiker aangemaakt: admin / duos2026 (wijzig dit wachtwoord na de eerste login!)');
}

console.log('Import voltooid.');
