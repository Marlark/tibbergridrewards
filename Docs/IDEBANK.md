# Idébank – Tibber Grid Rewards för Homey

Samlade idéer på förbättringar. Fyll på fritt. Flytta en idé till "Att göra" i README när den ska byggas.

**Värde:** ★ = trevligt, ★★ = bra, ★★★ = stor skillnad
**Insats:** S = timmar, M = en kväll eller två, L = större arbete

---

## Prioriterat

Inget valt just nu. Förslag: #3 smart styrning, #2 missad ersättning, #13 tidslinjen och #1 prognos.

---

## Siffror och statistik

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 1 | **Prognos för månaden** | ★★ | S | "Beräknat 690 kr i november", räknat på snittet per dag hittills. Ett värde med Insights, och i widgeten. |
| 2 | **Uppskattad missad ersättning** | ★★★ | M | När bilen är urkopplad eller hemmet ej tillgängligt: timmar × snittet per timme. "Du missade ca 4 kr idag." Visar vad det kostar att inte koppla in. |
| 5 | **Jämförelse med förra månaden** | ★★ | M | Spara en summa per dag i 13 månader (litet). Ger "+12 % mot samma datum förra månaden" i widget och månadsrapport. |
| 11 | **Månadsmål** | ★★ | S | Mål i inställningarna (t.ex. 600 kr), andel uppnått som värde med Insights, förloppsstapel i widgeten och flödeskort när målet nås. |
| 12 | **Total nytta idag** | ★★ | S | Grid Rewards och batteriets besparing ihop: "Idag: 16,64 kr intjänat + 3,21 kr sparat". Ett värde på hemmet och i dagssammanfattningen. |
| 17 | **Orsaksstatistik** | ★ | S | Andel sessioner och kronor per orsak (överskott, brist, annat) per månad. Datan finns i historiken. |
| 24 | **Ersättning i går** | ★★ | S | Nytt värde som sätts vid midnatt till gårdagens summa och står still hela dagen. I Insights blir det en trappa med ett steg per dag, så månadsvyn visar varje dags summa direkt. "Ersättning idag" är en sågtand som faller till 0 vid midnatt, och Homey visar längre perioder som medelvärden, så där syns inte dagssumman. Datan finns redan i dagssammanfattningen (`tracker.lastDay`). |
| 30 | **Tillgänglighet idag** | ★★ | S | Andel av dygnet hemmet varit tillgängligt eller levererat, i procent med Insights. Visar hur stor potentialen var, inte bara vad som betalats ut. |

## Flow-kort och notiser

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 6 | **Färdig notistext** | ★★ | S | Token i sessions- och dagskorten: "Grid Rewards: 2,53 kr på 50 min (överskott i nätet)". Notisflöden blir ett enda kort. |
| 7 | **Milstolpar** | ★ | S | "Totalt intjänat passerade 5 000 kr". Samma logik som tröskelkorten, för totalen. |
| 9 | **Åtgärdskort "Uppdatera nu"** | ★ | S | Hämtar batteriets uppgifter direkt och återansluter om anslutningen hänger. Bra vid felsökning. |
| 13 | **Tidslinjen utan flöden** | ★★ | S | Inställning "Skriv sessioner i tidslinjen": varje avslutad session och dagens summa i Homeys tidslinje, utan egna flöden. |
| 18 | **Veckosammanfattning** | ★ | S | Flödeskort söndag kväll med veckans summa, sessioner och jämförelse med förra veckan. Samma mönster som dag och månad. |
| 21 | **Ny ersättning registrerad** | ★ | S | Trigger när `rewardCurrentMonth` ökar, med token för ökningen i kr. Risk för brus: värdet ändras vid ungefär varannan uppdatering under en session. |
| 31 | **Rekord** | ★ | S | "Ny rekorddag: 24,10 kr" och "Längsta sessionen hittills", som Flow-kort och i historiken. Datan finns redan i historiken. |

## Batteriet

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 14 | **Batteriet planerar att ladda** | ★★ | M | Flödeskort "Batteriet laddar/laddar ur om X minuter", från tidslinjen som redan hämtas. Kan styra annan förbrukning efter batteriets plan. |
| 25 | **Villkor för batteriets aktivitet** | ★★ | S | Villkor "Batteriets aktivitet är …" med rullgardin över de kända koderna, och ett kort "Batteriet började ladda ur för Grid Rewards". Idag finns bara det generella "aktiviteten ändrades". |
| 26 | **Aktivitet uppdelad i typ och orsak** | ★★ | S | Koderna följer ett mönster: *Charging/Discharging/Idle* + *ForGridRewards/AtLowPrice/WithSolar…*. Två värden, "Laddar/Laddar ur/Vilar" och "Grid Rewards/Pris/Sol", förenklar flöden, och en ny okänd kod hamnar ändå rätt i typ. |
| 28 | **Okända koder synliga för användaren** | ★ | S | Nya batterikoder syns idag bara i loggen. Visa dem i batteriets inställningar ("Okända koder: …") med tips om att rapportera dem, så att även användare utan `homey app run` kan hjälpa till. |
| 29 | **Batteriets dygn** | ★★ | M | Ur aktivitetshistoriken som Tibber redan skickar: hur många timmar batteriet laddade för Grid Rewards, för pris och med sol. Sammanfattning per dag i dagskortet och på historiksidan. |

## Visning

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 4 | **Bästa tiderna på dygnet** | ★★ | M | Mönster per timme ur historiken på inställningssidan: när sessionerna kommer och vad de ger. Visar när bilen gör mest nytta inkopplad. |
| 10 | **Exportera historik** | ★ | S/M | CSV från inställningssidan, för egna analyser eller kalkylark. |

## Data och integrationer

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 19 | **Elpriset som sammanhang** | ★★ | L | Timpris via Tibbers officiella API (kräver egen API-token): "Grid Rewards täckte 8 % av elkostnaden idag". |

## Publicering och stabilitet

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 32 | **Stängningskod i inställningarna** | ★ | S | Senaste anledningen till att anslutningen stängdes (t.ex. *1001 Going away, efter 11 min*) under "Anslutningsstatus", så att felsökning inte kräver loggar. |
| 33 | **Larm vid instabil anslutning** | ★ | S | Flödeskort när anslutningen brutits fler än *X* gånger på en timme, eller när koden är något annat än 1000/1001. Fångar problem innan data saknas. |

---

## Nya idéer

<!-- Mall: | nr | **Namn** | ★★ | S | Kort beskrivning, varför och hur. | -->

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 34 | | | | |

---

## Parkerat

| # | Idé | Varför parkerad |
|---|---|---|
| 23 | **Undvik att spara lösenordet** | Utrett 2026-11-17 med `tools/inspect-login.js`. Inloggningen ger en `refreshToken`, men förnyelse mot `thewall.tibber.com/connect/token` ger `invalid_client`: den kräver Tibber-appens klienthemlighet, som bara finns på Tibbers server. Någon dokumenterad förnyelse via `app.tibber.com` finns inte. Tas upp igen om en sådan dyker upp (t.ex. i Home Assistant-integrationen). |

---

## Klart

Byggt 2026-11-17 (detaljer i [CHANGELOG.md](../CHANGELOG.md)):

- **Rätt siffror:** vänta in Tibbers avräkning när en session slutar
- **Enheter:** bil och batteri som egna enheter; husbatteriets besparing, aktivitet och planerade laddning
- **Statistik:** senaste session, sessioner och leveranstid per dag och månad; sessionshistorik på appens inställningssida
- **Flow-kort:** dagssammanfattning; månadsrapport; tröskelkort; ej tillgänglig länge; villkor "status är …"
- **Visning:** översatta orsaker; bilens/batteriets orsak på hemmet; dashboard-widget; anslutningsstatus i enhetens inställningar; valuta från Tibber
- **Språk:** norska, danska, tyska och nederländska (#16); bör granskas av modersmålstalare före publicering
- **Stabilitet:** larm när Tibbers API ändras; rätt `compatibility` (`>=12.3.0`); färre skrivningar till Homey (1 502 → 404 per dygn)

Byggt 2026-11-20:

- **Flow-kort:** larm när smart styrning stängs av, och villkor "smart styrning är på" (#3)
- **Visning:** widget för senaste 7 dagarna (#8)
- **Data:** historik och dagssummor sparas per hem i appen och överlever att hemmets enhet läggs till igen (#20)
- **Batteriet:** uppgifterna hämtas ca 10 s efter att Grid Rewards-statusen ändras i stället för upp till 5 min senare (#27)
- **Stabilitet:** en inloggning och en WebSocket per Tibber-konto, delad av kontots hem (#22)
- **Batteriet:** kurva över planerad laddnivå och planerad laddning/urladdning till slutet av i morgon, på appens inställningssida och som widget (#15)
