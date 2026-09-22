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

## Productie draaien

- Zet een reverse proxy (nginx/Caddy/IIS) met HTTPS voor poort 3000, of draai met `PORT=80`.
- Gebruik een procesmanager, bijv. `pm2 start server.js --name duos`.
- Maak periodiek een back-up van `data/duos.db` en `public/uploads/`.
- Het forum (forum.stichtingduos.nl) is een aparte site en blijft gewoon gelinkt.
