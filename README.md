# Winner

Enkel webbapp för statistik vid inomhusfotboll mellan kompisar. Ersätter Excel.
Node.js + Express + MongoDB. Varje installation använder sin egen MongoDB-databas.

## Kom igång

### 1. Klona och installera

```bash
git clone <repo-url> winner
cd winner
npm install
```

Kräver Node.js 20.19 eller senare (krav från Mongoose 9).

### 2. Skaffa en MongoDB-databas

Välj ett av alternativen:

- **Lokalt:** installera [MongoDB Community Server](https://www.mongodb.com/try/download/community) och använd t.ex. `mongodb://127.0.0.1:27017/winner`.
- **I molnet:** skapa ett gratis kluster i [MongoDB Atlas](https://www.mongodb.com/atlas), lägg till en databasanvändare och tillåt din IP-adress. Kopiera anslutningssträngen (`mongodb+srv://...`) och lägg till databasnamnet, t.ex. `/winner`.

Databasen och samlingarna skapas automatiskt första gången appen skriver data.

### 3. Skapa en egen `.env`

```bash
cp .env.example .env
```

(På Windows i PowerShell: `Copy-Item .env.example .env`.)

Öppna `.env` och fyll i:

| Variabel | Obligatorisk | Beskrivning |
|---|---|---|
| `MONGO_URI` | Ja | Anslutningssträng till **din** MongoDB. |
| `ADMIN_PASSWORD` | Ja | Lösenord för admin-läget. Välj ett eget, långt lösenord. Det finns inget standardlösenord. |
| `PORT` | Nej | Port för webbservern (standard `5000`). |
| `MATCH_PRICE` | Nej | Planhyra per match i kr för betalningsöversikten (standard `550`). |

`.env` ignoreras av Git. Checka aldrig in riktiga lösenord eller anslutningssträngar.

Saknas `MONGO_URI` eller `ADMIN_PASSWORD` avbryts starten med ett felmeddelande som talar om vad som fattas.

### 4. Starta appen

```bash
npm start
```

Öppna [http://localhost:5000](http://localhost:5000) (eller den port du valt).

En ny installation startar med en **tom databas**: inga spelare, inga matcher. Klicka på 🔐 i headern, logga in med ditt `ADMIN_PASSWORD` och lägg till dina egna spelare under admin.

### Valfritt: demodata

Vill du testa appen med påhittade spelare och några matcher:

```bash
npm run seed:demo
```

Skriptet lägger bara in data i en **tom** databas och avbryter annars, så befintliga spelare och matcher rörs aldrig. Demodata läggs aldrig in automatiskt.

## Vad som finns

- **Ranking-tabell** – sorterad efter vinstprocent och antal matcher.
- **Spelarstatistik** – vinster, förluster, oavgjorda, vinst %, streak, senaste matcher.
- **Matchhistorik** – senaste matchen kan redigeras eller tas bort av admin.
- **Matchanmälan och laggenerering** – spelare anmäler sig, admin genererar två lag och registrerar resultatet.
- **Admin** – registrera match, lägg till/ta bort spelare, justera statistik, avgifter och betalningar (CSV-export), backup (export/import av JSON).

All data lagras i MongoDB. Exporterade backuper (`stats-backup-*.json`) och betalningsexporter (`payments.csv`) innehåller riktiga namn – lägg dem inte i Git.
