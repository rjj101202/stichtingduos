# Stichting DUOS – nieuwe website

Volledig zelfstandige, handmatig aanpasbare website voor **stichtingduos.nl** (Dutch Uro-Oncology Studygroup), gebouwd met Node.js + Express + SQLite. Alle content van de oude WordPress-site is gemigreerd:

- **114 pagina's** (studies, patiënteninformatie, doneren, contact, enz. — alle oorspronkelijke URL's blijven werken)
- **2316 nieuwsberichten** met categorieën en tags
- **297 mediabestanden** (afbeeldingen en PDF's, lokaal in `public/uploads/`)
- Huisstijl behouden: DUOS-rood `#c3171b`, logo, menustructuur

## Starten

```bash
npm install        # eenmalig
npm start          # start de website op http://localhost:3000
```

De database (`data/duos.db`) is al gevuld. Opnieuw importeren vanaf de scrape-data kan met `npm run import` (let op: dit overschrijft alle pagina's en berichten met de oorspronkelijke content; instellingen en gebruikers blijven staan).

## Beheer (/admin)

Ga naar **http://localhost:3000/admin**

- Gebruikersnaam: `admin`
- Wachtwoord: `duos2026` — **wijzig dit direct na de eerste login** via Beheer → Wachtwoord.

### Wat kan er in het beheer?

| Onderdeel | Functie |
|---|---|
| **Dashboard** | Overzicht en snelkoppelingen |
| **Berichten** | Nieuwe blogs schrijven (TinyMCE-editor met afbeeldingen, tabellen, video), bewerken, zoeken, concept/publiceren, verwijderen |
| **Pagina's** | Alle vaste pagina's bewerken, nieuwe pagina's met eigen URL aanmaken |
| **Media** | Afbeeldingen/PDF's uploaden en URL's kopiëren |
| **Instellingen** | Naam, logo, homepage-teksten, kerncijfers, hero-slides, nieuwsbrief­banner, footer en het volledige menu (JSON) |
| **Wachtwoord** | Beheerderswachtwoord wijzigen |

### Tekst direct op de website bewerken

1. Log in en klik in het beheer op **"↗ Naar de website"** (of ga gewoon naar de site — u blijft ingelogd).
2. Bovenaan verschijnt een zwarte beheerbalk. Klik op **✏️ Bewerken**.
3. Alle bewerkbare teksten krijgen een rode stippellijn: klik erin en typ.
4. Klik onderaan op **"Wijzigingen opslaan"** (of Annuleren om terug te draaien).

Bewerkbaar op deze manier: titels en volledige inhoud van elke pagina en elk bericht, plus homepage-teksten, nieuwsbriefbanner en footerteksten.

## Structuur

```
server.js            Express-app met alle routes (publiek + /admin)
lib/db.js            SQLite-database + zoekindex (FTS5)
scripts/import.js    Importeert _scrape/*.json in de database
views/               EJS-templates (publiek + admin)
public/assets/       CSS en JavaScript
public/uploads/      Alle media (ook bereikbaar via oude /wp-content/uploads/-paden)
data/duos.db         De database (regelmatig back-uppen!)
_scrape/             De ruwe scrape-data van de oude site (mag na oplevering weg)
```

## Productie (Vercel)

De site draait live op **https://stichtingduos.vercel.app** (project `stichtingduos`, gekoppeld aan deze GitHub-repo — elke push naar `main` deployt automatisch).

Hoe het op Vercel werkt:
- De database (`duos.db`) staat in **Vercel Blob** (pad `db/duos.db`). Bij een cold start wordt hij naar `/tmp` gedownload; na elke wijziging in het beheer wordt hij automatisch teruggeschreven. Andere serverinstanties verversen binnen ±15 seconden.
- Nieuwe media-uploads gaan naar Vercel Blob; de bestaande 260+ bestanden worden statisch geserveerd uit `public/uploads/`.
- Environment variables op het project: `SESSION_SECRET` (login-cookies), `DUOS_DB_URL` (blob-URL van de database) en `BLOB_READ_WRITE_TOKEN` (automatisch, via de gekoppelde Blob-store).
- `POST /api/bootstrap-db` (Authorization: `Bearer <SESSION_SECRET>`, body `{"url": "..."}`) zet een verse database in de Blob-opslag — alleen nodig bij (her)initialisatie.
- Upload-limiet via het beheer is op Vercel ±4 MB per bestand (platform-limiet); grotere bestanden kun je in de repo onder `public/uploads/` zetten.
- Eigen domein (stichtingduos.nl) koppelen: Vercel-dashboard → project → Settings → Domains.

Back-up: download af en toe `db/duos.db` uit de Blob-store (dashboard → Storage) of bewaar een kopie van `data/duos.db`.

## Productie (eigen server, alternatief)

- Zet een reverse proxy (nginx/Caddy/IIS) met HTTPS voor poort 3000, of draai met `PORT=80`.
- Gebruik een procesmanager, bijv. `pm2 start server.js --name duos`.
- Maak periodiek een back-up van `data/duos.db` en `public/uploads/`.
- Het forum (forum.stichtingduos.nl) is een aparte site en blijft gewoon gelinkt.
