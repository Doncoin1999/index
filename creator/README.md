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
| `status` | Vis status for alle perioder |

En periode som er sendt inn, kan ikke endres.

## Utbetaling

Til Creator-modulen i Solana-programmet finnes, står `onchain.enabled` til `false`. Utbetalingen gjøres da fra `payouts/period-N.csv`, for eksempel som Streamflow-låser med 30 dagers cliff. Når modulen er klar, kobles `src/onchain.js` til den. Kontrakten er beskrevet i filen.

## Kostnad

X API tar betalt per oppslag (rundt $0.005 per post som leses). Med 20–50 influencere blir det trolig 10–50 dollar i måneden. Hver kjøring skriver antall kall i loggen.

## Testing uten X-nøkkel

```bash
cd creator
npm test                 # enhetstester for regler, poeng, fordeling og hash
npm run simulate         # kjører boten hver dag fra 20.11.2026 til 26.10.2027 med falske data
```

## Begrensninger å kjenne til

- X sitt søk dekker bare de siste 7 dagene. Står boten stille i mer enn en uke, kan poster og registreringer bli borte. GitHub Actions kan i tillegg skru av planlagte jobber i repoer uten aktivitet på 60 dager, men det skjer ikke her, fordi boten selv lagrer endringer hver dag.
- Poster som slettes før perioden avgjøres, teller ikke.
- Kontroll av botter kan ikke bli perfekt. Les flaggene i forslaget før det sendes inn.
