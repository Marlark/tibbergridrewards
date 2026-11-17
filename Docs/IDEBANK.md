# Idébank – Tibber Grid Rewards för Homey

Samlade idéer på förbättringar. Fyll på fritt. Flytta en idé till "Att göra" i README när den ska byggas.

**Värde:** ★ = trevligt, ★★ = bra, ★★★ = stor skillnad
**Insats:** S = timmar, M = en kväll eller två, L = större arbete

---

## Prioriterat

Inget valt just nu.

---

## Flow-kort

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 5 | **Ny ersättning registrerad** | ★ | S | Trigger när `rewardCurrentMonth` ökar, med token för ökningen i kr. Risk för brus: värdet ändras vid ungefär varannan uppdatering under en session. |

## Stabilitet

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 6 | **En inloggning och anslutning per konto** | ★★ | M | Idag loggar varje hem in och öppnar en egen WebSocket. Dela klient och anslutning per e-post och starta en subscription per hem på samma socket (`graphql-transport-ws` stöder flera id:n). Spelar bara roll med flera hem. |

---

## Nya idéer

<!-- Mall: | nr | **Namn** | ★★ | S | Kort beskrivning, varför och hur. | -->

| # | Idé | Värde | Insats | Anteckning |
|---|---|---|---|---|
| 8 | | | | |

---

## Parkerat

| # | Idé | Varför parkerad |
|---|---|---|
| 7 | **Undvik att spara lösenordet** | Utrett 2026-11-17 med `tools/inspect-login.js`. Inloggningen ger en `refreshToken`, men förnyelse mot `thewall.tibber.com/connect/token` ger `invalid_client`: den kräver Tibber-appens klienthemlighet, som bara finns på Tibbers server. Någon dokumenterad förnyelse via `app.tibber.com` finns inte. Tas upp igen om en sådan dyker upp (t.ex. i Home Assistant-integrationen). |

---

## Klart

Byggt 2026-11-17 (detaljer i [CHANGELOG.md](../CHANGELOG.md)):

- **Rätt siffror:** vänta in Tibbers avräkning när en session slutar
- **Enheter:** bil och batteri som egna enheter; husbatteriets besparing, aktivitet och planerade laddning
- **Statistik:** senaste session, sessioner och leveranstid per dag och månad; sessionshistorik på appens inställningssida
- **Flow-kort:** dagssammanfattning; ej tillgänglig länge; villkor "status är …"
- **Visning:** översatta orsaker; dashboard-widget; anslutningsstatus i enhetens inställningar
- **Stabilitet:** larm när Tibbers API ändras; rätt `compatibility` (`>=12.3.0`)
- **Senare samma dag:** tröskelkort; månadsrapport; bilens/batteriets orsak på hemmet; valuta från Tibber
