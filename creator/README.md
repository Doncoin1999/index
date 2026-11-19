# DON Creator Program – ranker-bot

Boten rangerer X-influencere i DON Creator Program automatisk og forbereder utbetalingen for hver periode. Den kjører som en daglig jobb i GitHub Actions i nettside-repoet (`Doncoin1999/index`) og trenger ingen server.

## Hva den gjør hver dag (06:17 UTC)

1. **Registrering.** Den finner nye poster med `#DONCreator` og en Solana-adresse og registrerer forfatteren som influencer. En ny registreringspost med en annen adresse bytter wallet.
2. **Innsamling.** Den søker etter poster fra registrerte influencere som nevner `doncoin`, `doncoin.app` eller DONCOIN-kontoen. Retweets og svar teller ikke.
3. **Oppdatering.** Den henter ferske tall (visninger, reposts, svar, likes) for poster fra de siste 10 dagene og merker slettede poster.
4. **Leaderboard.** Den skriver `results/leaderboard.json`, som `creators.html` på doncoin.app viser.
5. **Periodeslutt.** 48 timer etter at en periode er slutt, henter den endelige tall, regner ut topp 5 og publiserer et **forslag** (`results/period-N.json`).
6. **Innsending.** 24 timer etter forslaget sendes resultatet inn automatisk, med mindre du har grepet inn. Da skrives `payouts/period-N.csv` med wallets og beløp, og datoen DON-ene kan hentes ut fra (30 dager etter tildeling).

Med standardoppsettet blir hver periode avgjort cirka 3 dager etter at den er slutt. For eksempel blir periode 1 avgjort 23. mars 2027, og DON-ene kan hentes ut fra 22. april 2027.

## Regler (i `config.json`)

| Regel | Standard |
|---|---|
| Poster må nevne | `doncoin` / `doncoin.app` / DONCOIN-kontoen |
| Må merkes | `#ad`, `#advertisement`, `#sponsored` eller "paid partnership" |
| Må inneholde | "not an investment" |
| Forbudte uttrykk | "to the moon", "100x", "price target", "next bitcoin", "financial advice" … |
| Kontoens alder | minst 183 dager ved periodens slutt |
| Følgere | minst 1 000 |
| Poeng per post | repost 3, sitat 3, svar 2, like 1, + 1 per 100 visninger |
| Poster som teller | de 10 beste per måned (40 i periode 1) |
| Fordeling | 35 / 25 / 18 / 12 / 10 %, minus konverteringsgebyret (3 %) |
| Rest | går til neste periode; etter periode 8 tilbake til Development Team |

**Kontroll mot juks:**
- Over 25 % engasjement på en post med minst 1 000 visninger gir flagget **high**. Kontoen holdes da utenfor topp 5 til du klarerer den.
- Flere visninger enn 30 × antall følgere gir **medium** (bare til gjennomsyn).
- At én post står for over 60 % av poengene gir **info**.

Poengberegningen ligger i `src/score.js` og har ingen nettverkskall, så den kan kontrolleres av hvem som helst. Hvert resultat får en SHA-256-hash av alle poeng og vinnere. Den er ment å lagres on-chain når Creator-modulen finnes.

## Oppsett (én gang)

1. Kopier `creator/`, `.github/workflows/creator-ranker.yml` og `creators.html` inn i repoet `Doncoin1999/index`.
2. DONCOINs X-konto (`doncointhegame`) er allerede lagt inn i `config.json` → `projectHandle`.
3. Lag en app i X Developer Console og kopier **Bearer Token**. Legg den inn i repoet under *Settings → Secrets and variables → Actions → New repository secret* med navnet `X_BEARER_TOKEN`. Kjøp litt kreditt (pay-per-use).
4. Under *Settings → Actions → General → Workflow permissions* velger du **Read and write permissions**, så boten kan lagre resultatene.
5. Kjør jobben én gang manuelt: *Actions → DON Creator ranker → Run workflow* (command: `status`).

## Å gripe inn (fra Actions-fanen → Run workflow)

| Kommando | Bruk |
|---|---|
| `approve` + period | Send inn forslaget med en gang |
| `veto` + period + user | Hold en influencer utenfor perioden (forslaget regnes ut på nytt) |
| `unveto` + period + user | Angre en veto |
| `clear` + period + user | Godta et high-flagg etter manuell sjekk |
| `propose` + period | Regn ut forslaget på nytt fra lagrede data |
| `payout` | Kjør utbetalingen nå (følger `dryRun`) |
| `payout-retry` + period + rank | Tillat at en mislykket utbetaling sendes på nytt |
| `status` | Vis status for alle perioder og utbetalinger |

En periode som er sendt inn, kan ikke endres.

## Automatisk utbetaling

Boten sender belønningene selv fra en egen **Creator Program-wallet**, 30 dager etter at en periode er avgjort. Ingenting sendes før det, så ingen kan selge før sperren er over. Hver utbetaling er en offentlig Solana-transaksjon som lenkes fra resultatlisten. Boten har aldri tilgang til Development Teams egen wallet.

### Oppsett (gjøres i mars 2027, før første utbetaling rundt 22. april)

1. **Lag en ny wallet** som bare brukes til Creator Program, for eksempel en ny konto i Phantom. Bruk den ikke til noe annet.
2. **Når Development Team-tildelingen låses opp (ca. 21. mars 2027):** Konverter 150 000 DON i appen fra Development Team-kontoen. Etter 3 % gebyr får du 145 500 DON. Send alle 145 500 DON til den nye wallet-en, og send også **0,1 SOL** til gebyrer.
3. **Legg inn adressen:** Skriv den offentlige adressen inn i `config.json` → `payout.payoutWallet`.
4. **Legg inn nøkkelen som secret:** Eksporter privatnøkkelen (Phantom: *Settings → Manage accounts → Show private key*) og lagre den som repository-secret `PAYOUT_KEYPAIR`. Den skal **aldri** limes inn noe annet sted.
5. **Valgfritt:** Legg inn en egen RPC-adresse, for eksempel fra Helius, som secret `PAYOUT_RPC`. Den offentlige RPC-en fungerer også, men er tregere.
6. **Prøvekjøring:** Sett `payout.enabled` til `true` og la `payout.dryRun` stå på `true`. Kjør `payout` fra Actions og les planen i loggen ("DRY RUN, would send …").
7. **Slå på:** Når planen stemmer, setter du `payout.dryRun` til `false`. Fra da av betaler boten ut av seg selv i den daglige kjøringen.

### Sikkerhet

- **Sjekk av resultatet:** Bare perioder som er sendt inn, og der resultatfilen fortsatt har samme SHA-256-hash, blir betalt ut. Blir filen endret i ettertid, stopper utbetalingen.
- **Tak:** Én utbetaling kan være på maks `maxSingleDon` (26 250 DON), og alle utbetalinger til sammen maks `budgetDon` (145 500 DON).
- **Ingen dobbel betaling:** Transaksjonens signatur lagres *før* den sendes. Krasjer en kjøring, sjekker neste kjøring signaturen. Den sender på nytt bare hvis den første transaksjonen beviselig aldri kom frem.
- **Saldosjekk:** Boten sjekker at wallet-en har nok DON og SOL før den sender noe.
- **Varsling:** Ved problemer avslutter kjøringen med feil, og GitHub sender deg e-post. Linjene `PAYOUT PROBLEM` i loggen forteller hva som er galt.
- **Hvis noe feiler:** En utbetaling som har feilet, kan sendes på nytt med `payout-retry` + period + rank, etter at du har rettet årsaken.
- **Hvis nøkkelen lekker:** Det mest som kan gå tapt, er det som er igjen i Creator Program-wallet-en. Slå på tofaktorinnlogging på GitHub-kontoen, fordi den som kan endre workflow-filen, i prinsippet kan hente ut secrets.

`payouts/period-N.csv` lages fortsatt, i tilfelle du vil betale manuelt.

## Kostnad

X API tar betalt per oppslag (rundt $0.005 per post som leses). Med 20–50 influencere blir det trolig 10–50 dollar i måneden. Hver kjøring skriver antall kall i loggen.

## Testing uten X-nøkkel

```bash
cd creator
npm install
npm test                 # regler, poeng, fordeling, hash og utbetaling (dobbel betaling, krasj, tak)
npm run simulate         # kjører boten hver dag fra 20.11.2026 til 24.11.2027 med falske data og en simulert Solana
```

## Begrensninger å kjenne til

- X sitt søk dekker bare de siste 7 dagene. Står boten stille i mer enn en uke, kan poster og registreringer bli borte. GitHub Actions kan i tillegg skru av planlagte jobber i repoer uten aktivitet på 60 dager, men det skjer ikke her, fordi boten selv lagrer endringer hver dag.
- Poster som slettes før perioden avgjøres, teller ikke.
- Kontroll av botter kan ikke bli perfekt. Les flaggene i forslaget før det sendes inn.
