# Idébank – Tibber Grid Rewards för Homey

Samlade idéer på förbättringar. Fyll på fritt. Flytta en idé till "Att göra" i README när den ska byggas.

**Värde:** ★ = trevligt, ★★ = bra, ★★★ = stor skillnad
**Insats:** S = timmar, M = en kväll eller två, L = större arbete

---

## Prioriterat – topp 5

1. **#1 Vänta in ersättningen när en session slutar.** Annars kan sessionskortet visa 0 kr. Slå på "Spela in rådata" först för att se hur Tibber faktiskt beter sig.
2. **#20 Larma när API:t ändras.** Den största risken med appen. Utan larm försöker den tyst återansluta i all evighet.
3. **#6 Dagssammanfattning.** Stort värde för liten insats: notiser och dagliga energianalyser.
4. **#5 Översätt orsakerna.** Samma inspelning som till #1 visar vilka koder Tibber skickar, så de två görs med fördel tillsammans.
5. **#11 Bil och batteri som egna enheter.** Det största nästa steget, när grunden är stabil. Datan finns redan i subscriptionen.

---

## 1. Rätt siffror

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 1 | **Vänta in ersättningen när en session slutar** | ★★★ | M | `session_ended` triggas just när status lämnar `delivering`. Tibber räknar troligen fram `rewardCurrentMonth` först efteråt. Vänta på nästa ändring av månadsvärdet (eller max ca 15 min) innan kortet triggas, eller rätta `lastSession` i efterhand. |
| 2 | **Valuta från Tibber** | ★★ | S | `rewardCurrency` hämtas men används inte. Enheten är hårdkodad till "kr", vilket blir fel för användare i Norge eller med euro. Sätt enheten med `setCapabilityOptions` vid första uppdateringen. |
| 3 | **Visa senaste sessionen** | ★★ | S | `tracker.lastSession` (ersättning, minuter, sluttid) sparas redan men visas ingenstans. Lägg till capabilities som `grid_reward_last_session` och "senast levererat". |
| 4 | **Antal sessioner och leveranstid per dag/månad** | ★★ | S | Räknas i `RewardTracker` med samma dygns- och månadslogik. Bra att ha i Insights. |
| 5 | **Översätt orsakerna** | ★★ | S | `grid_reward_reason` visar Tibbers råa värden (`frequencyRegulation`, `vehicleNotPluggedIn`...). Översätt dem till svenska och engelska och låt okända värden passera som de är. Logga vilka värden som faktiskt dyker upp. |

## 2. Flow-kort

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 6 | **Dagssammanfattning** | ★★★ | S | Trigger "Dagens Grid Rewards" vid dygnsbytet med tokens: ersättning idag, antal sessioner, minuter. Gör det enkelt att skicka en notis eller logga till Google Sheets. |
| 7 | **Tröskelkort** | ★★ | S | Trigger "Ersättningen idag/månad passerade X kr". Villkor "Ersättningen idag är över X kr". |
| 8 | **Villkor: status är …** | ★★ | S | Ett villkor med dropdown (tillgänglig / ej tillgänglig / levererar). Ersätter flera flöden på `state_changed`. |
| 9 | **Ej tillgänglig för länge** | ★★ | S | Trigger när status har varit `unavailable` längre än X timmar. Fångar t.ex. att bilen inte är inkopplad eller att smartladdning är avstängd. |
| 10 | **Ny ersättning registrerad** | ★ | S | Trigger när `rewardCurrentMonth` ökar, med token för ökningen i kr. |

## 3. Nya enheter och data (fas 2)

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 11 | **flexDevices som egna enheter** | ★★★ | L | Bil och batteri finns redan i subscriptionen (`flexDevices`). En enhet per fordon/batteri med status, `isPluggedIn` och `isSmartChargingEnabled`. Ger villkor som "bilen är inkopplad". |
| 12 | **Husbatteriet** | ★★ | L | Besparing, aktivitetsorsak och planerat schema via GraphQL med polling var 5:e minut (står redan i README). |
| 13 | **Varför är jag inte tillgänglig?** | ★★ | M | Kombinera `reasons` från flexDevices till en tydlig text: "Bilen är inte inkopplad" i stället för en kod. |

## 4. Visa upp datan

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 14 | **Dashboard-widget** | ★★★ | M | Homey Pro-widget: status, ersättning idag, månad och pågående session med en enkel stapel per dag. |
| 15 | **Sessionshistorik** | ★★ | M | Spara de senaste ca 100 sessionerna (start, slut, ersättning, orsak) och visa dem på en inställningssida eller i widgeten. |
| 16 | **Månadsrapport** | ★ | S | Trigger vid månadsskiftet med förra månadens total. Kan skickas som notis. |

## 5. Stabilitet och säkerhet

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 17 | **En inloggning och anslutning per konto** | ★★ | M | Idag loggar varje hem in och öppnar en egen WebSocket. Dela klient och anslutning per e-post och starta en subscription per hem på samma socket (`graphql-transport-ws` stöder flera id:n). |
| 18 | **Undvik att spara lösenordet** | ★★ | M | Undersök om login-svaret innehåller en refresh-token eller om JWT:n lever länge. Spara i så fall bara token och be om lösenord vid reparation. |
| 19 | **Status för anslutningen** | ★★ | S | Visa "senast uppdaterad" och anslutningsstatus i enhetens inställningar, så felsökning inte kräver loggar. |
| 20 | **Larma när API:t ändras** | ★★ | S | Om GraphQL svarar med schemafel ska enheten bli otillgänglig med ett tydligt meddelande ("Tibber har ändrat sitt API") i stället för att tyst återansluta i all evighet. |
| 21 | **Kontrollera `compatibility`** | ★ | S | `fetch` och `AbortSignal.timeout` kräver Node 18+. Sätt lägsta Homey-version därefter. |

---

## Nya idéer

<!-- Mall: | nr | **Namn** | ★★ | S | Kort beskrivning, varför och hur. | -->

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 22 | | | | |
