# Idébank – Tibber Grid Rewards för Homey

Samlade idéer på förbättringar. Fyll på fritt under "Nya idéer"; de sorteras in under rätt rubrik vid nästa städning. Numren är fasta, så att de går att hänvisa till.

**Värde:** ★ = trevligt, ★★ = bra, ★★★ = stor skillnad
**Insats:** S = timmar, M = en kväll eller två, L = större arbete

---

## Prioriterat

Inget valt just nu. Förslag: #57 senast uppdaterad, #40 kopiera diagnostik, #24 ersättning i går och #2 missad ersättning.

---

## Siffror och statistik

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 1 | **Prognos för månaden** | ★★ | S | "Beräknat 690 kr i november", räknat på snittet per dag hittills. Ett värde med Insights, och i widgeten. |
| 2 | **Uppskattad missad ersättning** | ★★★ | M | När bilen är urkopplad eller hemmet ej tillgängligt: timmar × snittet per timme. "Du missade ca 4 kr idag." Visar vad det kostar att inte koppla in. Hänger ihop med #38. |
| 5 | **Jämförelse med förra månaden** | ★★ | S | "+12 % mot samma datum förra månaden" i widget och månadsrapport. Dagssummorna sparas redan i ca ett år (#20). |
| 11 | **Månadsmål** | ★★ | S | Mål i inställningarna (t.ex. 600 kr), andel uppnått som värde med Insights, förloppsstapel i widgeten och flödeskort när målet nås. |
| 12 | **Total nytta idag** | ★★ | S | Grid Rewards och batteriets besparing ihop: "Idag: 16,64 kr intjänat + 3,21 kr sparat". Ett värde på hemmet och i dagssammanfattningen. |
| 17 | **Orsaksstatistik** | ★ | S | Andel sessioner och kronor per orsak (överskott, brist, annat) per månad. Datan finns i historiken. |
| 24 | **Ersättning i går** | ★★ | S | Värde som sätts vid midnatt till gårdagens summa och står still hela dagen. I Insights blir det en trappa med ett steg per dag, så månadsvyn visar varje dags summa. "Ersättning idag" är en sågtand som faller till 0 vid midnatt, och Homey visar längre perioder som medelvärden, så där syns inte dagssumman. |
| 44 | **Sessionens ersättning live** | ★ | M | Uppskattad ersättning under pågående session, räknad på snittet per minut från tidigare sessioner med samma orsak. Ersätts av den riktiga summan när Tibber räknat klart. |

## Historiksidan

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 4 | **Bästa tiderna på dygnet** | ★★ | M | Mönster per timme ur historiken: när sessionerna kommer och vad de ger. Visar när bilen gör mest nytta inkopplad. |
| 35 | **Månadsöversikt** | ★★ | S | Tabell per månad: summa, sessioner och tid. Räknas ur dagssummorna (ca ett år). |
| 36 | **Kalendervy** | ★★ | M | Dagarna som rutor i ett rutnät, färgade efter ersättning. Mönster som helger, säsong och dagar utan inkopplad bil syns direkt. |
| 56 | **Avräkningar synliga** | ★ | S | Tibbers efterjustering per session: "+0,19 kr avräknat efter 40 s". Visar att appen räknar rätt och fångar om Tibber ändrar avräkningen. |
| 60 | **Valfri period** | ★ | S | Välj från- och till-datum och få summa, sessioner och tid, t.ex. för ett kvartal eller sommaren. Räknas ur dagssummorna. |

## Flow-kort och notiser

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 6 | **Färdig notistext** | ★★ | S | Token i sessions- och dagskorten: "Grid Rewards: 2,53 kr på 50 min (överskott i nätet)". Notisflöden blir ett enda kort. |
| 7 | **Milstolpar** | ★ | S | "Totalt intjänat passerade 5 000 kr". Samma logik som tröskelkorten, för totalen. |
| 9 | **Åtgärdskort "Uppdatera nu"** | ★ | S | Hämtar batteriets uppgifter direkt och återansluter om anslutningen hänger. Bra vid felsökning. |
| 13 | **Tidslinjen utan flöden** | ★★ | S | Inställning "Skriv sessioner i tidslinjen": varje avslutad session och dagens summa i Homeys tidslinje, utan egna flöden. |
| 18 | **Veckosammanfattning** | ★ | S | Flödeskort söndag kväll med veckans summa, sessioner och jämförelse med förra veckan. Samma mönster som dag och månad. |
| 21 | **Ny ersättning registrerad** | ★ | S | Trigger när `rewardCurrentMonth` ökar, med token för ökningen i kr. Risk för brus: värdet ändras vid ungefär varannan uppdatering under en session. |
| 37 | **Årssammanfattning** | ★ | S | Flödeskort 1 januari: "2026: 4 210 kr på 812 sessioner". Samma mönster som dag- och månadskorten. |
| 39 | **Varning vid tyst period** | ★★ | S | Flödeskort när hemmet varit tillgängligt men inte fått någon session på *X* dagar. Fångar att Tibber slutat skicka sessioner eller att avtalet ändrats. |
| 46 | **Diagram som bildtoken** | ★★ | M | Veckodiagrammet eller batteriplanen som bild-token i dags- och månadskorten. Kan skickas vidare med Telegram, Pushover eller e-post från ett flöde. |
| 47 | **Testkort "Simulera session"** | ★★ | S | Åtgärdskort som skickar en påhittad session (start och slut med summa) genom korten, så att notisflöden kan testas utan att vänta på en riktig session. |
| 54 | **Semesterläge** | ★ | S | Åtgärdskort och inställning som pausar larmen om att bilen eller hemmet inte är tillgängligt. Statistiken fortsätter som vanligt. |
| 59 | **Session pågått i X minuter** | ★ | S | Trigger när en pågående session passerar *X* minuter. Kan t.ex. skjuta upp diskmaskinen under långa sessioner. |

## Bilen

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 38 | **Bilens inkopplingstid** | ★★ | S | Timmar inkopplad per dag som värde med Insights och i dagskortet, och "kr per inkopplad timme". Visar hur mycket det lönar sig att koppla in. Hänger ihop med #2. |
| 49 | **Bilens batterinivå** | ★★ | M | Om Tibber skickar bilens laddnivå och räckvidd i flexDevices: visa dem på bilen, med kort som "bilen under 30 %". Måste verifieras mot en riktig inspelning (se #51). |
| 65 | **Inkopplad sedan** | ★★ | S | Värden "Inkopplad sedan 18:42" och "Urkopplad sedan 07:09" på bilen. Visar hur länge bilen stått utan att öppna Insights. |
| 70 | **Vilken enhet levererade** | ★ | S | Token med enhetens namn i hemmets sessionskort: "Grid Rewards: 1,73 kr från bilen". Sessionerna vet redan vilken enhet som levererade. |
| 72 | **Koll mot laddboxen** | ★★ | M | Välj en laddbox eller bil från en annan Homey-app (Easee, Zaptec, bilens app). Om den säger "inkopplad" men Tibber säger "ingen bil inkopplad": varning, eftersom Tibbers koppling till bilen troligen har tappat. |
| 74 | **Inbyggd inkopplingspåminnelse** | ★★ | S | Inställning på bilen: "Påminn om bilen inte är inkopplad kl. 20". Notis utan eget flöde. Kan senare använda tiderna från #4. |

## Batteriet

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 14 | **Batteriets plan i Flow** | ★★ | M | Ur planen som redan hämtas (#15): trigger "Batteriet laddar/laddar ur om X minuter" och villkor "planerad laddnivå kl. 17 är över 80 %". Kan styra annan förbrukning efter batteriets plan. Inkluderar #43. |
| 25 | **Villkor för batteriets aktivitet** | ★★ | S | Villkor "Batteriets aktivitet är …" med rullgardin över de kända koderna, och ett kort "Batteriet började ladda ur för Grid Rewards". Idag finns bara det generella "aktiviteten ändrades". |
| 26 | **Aktivitet uppdelad i typ och orsak** | ★★ | S | Koderna följer ett mönster: *Charging/Discharging/Idle* + *ForGridRewards/AtLowPrice/WithSolar…*. Två värden, "Laddar/Laddar ur/Vilar" och "Grid Rewards/Pris/Sol", förenklar flöden, och en ny okänd kod hamnar ändå rätt i typ. |
| 28 | **Okända koder synliga för användaren** | ★ | S | Nya batterikoder syns idag bara i loggen. Visa dem i batteriets inställningar ("Okända koder: …") med tips om att rapportera dem. Kan ingå i #40. |
| 29 | **Batteriets dygn** | ★★ | M | Ur aktivitetshistoriken: hur många timmar batteriet laddade för Grid Rewards, för pris och med sol. Sammanfattning per dag i dagskortet och på historiksidan. |
| 48 | **Energi genom batteriet** | ★★ | S | kWh laddat och urladdat per dag ur tidslinjens ACTUAL-värden, totalt och för Grid Rewards. Visar hur mycket batteriet används och ger en bild av slitaget. |
| 50 | **Inställbart uppdateringsintervall** | ★ | S | Batteriets intervall i inställningarna (2, 5 eller 10 min) i stället för fasta 5 minuter. Kortare ger färskare värden, längre ger färre anrop till Tibber. |
| 55 | **Besparingen uppdelad** | ★★ | S | `batteryValueItems` har fler typer än TOTAL (t.ex. OTHER). Visa hur mycket som kommer från Grid Rewards, prisstyrning och sol. Datan finns redan i svaret. |

## Widgets och visning

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 42 | **Kompakt widget** | ★ | S | Enradsvariant: "● Levererar · 12,40 kr idag". För små dashboards och telefonens startskärm. |
| 53 | **Alla hem i en widget** | ★ | S | Ett läge i statuswidgeten som summerar alla hem, för den som har t.ex. villa och stuga. |
| 57 | **Senast uppdaterad** | ★★ | S | Värde på hemmet, "Data från 10:07", och samma tid i widgeten. Visar direkt om siffrorna är färska eller om anslutningen hänger. |

## Data och integrationer

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 19 | **Elpriset som sammanhang** | ★★ | L | Timpris via Tibbers officiella API (kräver egen API-token): "Grid Rewards täckte 8 % av elkostnaden idag". |
| 51 | **Kartlägg API:t** | ★★ | M | Verktyg i `tools/` som provar fält mot Tibbers GraphQL och listar vad som finns, t.ex. kWh per session eller bilens laddnivå. Underlag för #49 och #61. |
| 61 | **Utbetalt mot intjänat** | ★★ | M | Om Tibbers API visar vad som faktiskt betalats ut per månad: jämför med appens summa. Bekräftar att siffrorna stämmer. Kräver #51 först. |

## Stabilitet och felsökning

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 32 | **Stängningskod i inställningarna** | ★ | S | Senaste anledningen till att anslutningen stängdes (t.ex. *1001 Going away, efter 11 min*) under "Anslutningsstatus", så att felsökning inte kräver loggar. |
| 33 | **Larm vid instabil anslutning** | ★ | S | Flödeskort när anslutningen brutits fler än *X* gånger på en timme, eller när koden är något annat än 1000/1001. Fångar problem innan data saknas. |
| 40 | **Kopiera diagnostik** | ★★ | S | Knapp på inställningssidan som kopierar appversion, anslutningsstatus, senaste stängningskoder, okända batterikoder och senaste fel, utan ID:n eller e-post. Gör buggrapporter på GitHub enkla. Kan ta upp #28 och #32. |

## Kom igång och publicering

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 41 | **Demoläge** | ★★ | M | Spelar upp en anonymiserad inspelning i stället för att ansluta till Tibber. Hjälper Athoms granskare och nya användare utan Grid Rewards att se hur appen fungerar. Inspelning och uppspelning finns redan i `tools/`. |
| 52 | **Kom igång-koll i parningen** | ★★ | M | Ett sista parningssteg med checklista: smart laddning på, bil eller batteri hittat, Grid Rewards aktivt. Fångar de vanligaste orsakerna till att inget händer. |
| 58 | **Vanliga frågor i appen** | ★★ | S | Liten FAQ på inställningssidan: varför 0 kr, varför summan ändras efter en session, vad "ej tillgänglig" betyder, hur man byter lösenord. |
| 62 | **Exempelflöden i README** | ★★ | S | Tre till fem färdiga flöden med skärmbilder: notis när en session slutar, larm när bilen inte är inkopplad, månadsbesked. |
| 63 | **Skärmbilder till App Store** | ★★ | S | Riktiga skärmbilder av enheter, widgets och historiksidan till appens sida i Homey App Store. |
| 64 | **Testgrupp på Homey Community** | ★★ | S | Publicera en testversion och be om testare i en tråd på community.homey.app. Fler hem ger fler okända koder och riktiga inspelningar, t.ex. med bilar och andra batterimärken. |

---

## Nya idéer

<!-- Mall: | nr | **Namn** | ★★ | S | Kort beskrivning, varför och hur. | -->

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 65 | | | | |

---

## Parkerat

| # | Idé | Varför parkerad |
|---|---|---|
| 23 | **Undvik att spara lösenordet** | Utrett 2026-11-17 med `tools/inspect-login.js`. Inloggningen ger en `refreshToken`, men förnyelse mot `thewall.tibber.com/connect/token` ger `invalid_client`: den kräver Tibber-appens klienthemlighet, som bara finns på Tibbers server. Någon dokumenterad förnyelse via `app.tibber.com` finns inte. Tas upp igen om en sådan dyker upp (t.ex. i Home Assistant-integrationen). |

Sammanslaget: #43 ingår i #14. Nummer som saknas (34, 45) valdes bort.

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
- **Batteriet:** uppgifterna hämtas ca 10 s efter att Grid Rewards-statusen ändras i stället för upp till 5 min senare (#27)
- **Batteriet:** kurva över planerad laddnivå och planerad laddning/urladdning till slutet av i morgon, på appens inställningssida och som widget (#15)
- **Visning:** widget för senaste 7 dagarna (#8)
- **Data:** historik och dagssummor sparas per hem i appen och överlever att hemmets enhet läggs till igen (#20)
- **Data:** export av sessioner och dagssummor som CSV från appens inställningssida, att ladda ner eller kopiera (#10)
- **Stabilitet:** en inloggning och en WebSocket per Tibber-konto, delad av kontots hem (#22)
- **Bilen och batteriet:** intjänat idag, denna månad och totalt på bilens och batteriets enheter, och kortet "session slutade" per enhet. Varje session förs till enheten som levererade under den.
- **Bilen och batteriet:** sessioner och leveranstid idag och denna månad (#66), andel av månadens intjäning (#67), egen ikon vid parning (#71) och rekord med Flow-kort (#73)
- **Statistik:** tillgänglig idag i procent, för hemmet (#30) och för bilen och batteriet (#68)
- **Historiksidan:** kolumn och filter för vilken bil eller vilket batteri som levererade, också i CSV-exporten (#69); rekord för hemmet och varje enhet
- **Flow-kort:** nytt rekord för bästa dag, bästa session och längsta session, på hemmet (#31) och på bilen och batteriet (#73)
