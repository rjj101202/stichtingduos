/*
 * Uploadt data/duos.db naar Vercel Blob (pad db/duos.db).
 * Gebruik:  BLOB_READ_WRITE_TOKEN=... node scripts/push-db.js
 * Print de blob-URL die als DUOS_DB_URL environment variable ingesteld moet worden.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { put } = require('@vercel/blob');

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Zet eerst BLOB_READ_WRITE_TOKEN als environment variable.');
    process.exit(1);
  }
  const dbPath = path.join(__dirname, '..', 'data', 'duos.db');
  // WAL netjes in het hoofdbestand zetten voordat we uploaden
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const buf = fs.readFileSync(dbPath);
  console.log(`Uploaden van ${(buf.length / 1024 / 1024).toFixed(1)} MB...`);
  const blob = await put('db/duos.db', buf, {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 60,
  });
  console.log('Klaar. DUOS_DB_URL =', blob.url);
}

main().catch(e => { console.error(e); process.exit(1); });
