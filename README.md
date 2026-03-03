# Sugekort Bar PWA (local-first MVP)

Offline-first Android PWA prototype for a biker clubhouse bar using NFC cards as member IDs and local prepaid balances.

## Features (MVP)

- Web NFC scan (Chrome on Android) using NDEF text record (with serial fallback)
- Card registration flow (can write new NDEF ID to tag)
- IndexedDB local database (cards / balances / transactions / settings)
- Quick top-up and deductions
- Transaction log with reproducible balance changes
- No backend / no cloud (single-device local storage)
- Service Worker + manifest (installable PWA, offline after first load)
- Export all data to JSON
- Export transaction history to CSV
- Optional JSON import (overwrites local data)
- Optional admin PIN for custom amounts / block-unblock

## Important Browser / Device Notes

Web NFC works only in supported browsers/environments (typically Chrome on Android) and usually requires:

- HTTPS (or localhost during development)
- NFC enabled on the phone
- User interaction to start scanning
- NDEF-compatible tags/cards

## Suggested Test Flow

1. Open app on Android Chrome and install as PWA
2. Press **Start NFC scan**
3. Scan an NFC tag/card
4. If unknown -> create member and optionally write NDEF ID to card
5. Use quick buttons (+100 / -10 / -25 / -50)
6. Open history and verify transaction log
7. Export JSON backup + CSV transaction log
8. Put phone in airplane mode and verify app still works

## Data Model

Amounts are stored in **øre (integers)** to avoid floating-point issues.

## Known MVP Limitations

- Single-device only (no sync)
- No role/user accounts (operator name is local setting)
- No cryptographic hardware security (internal club tool only)
- Web NFC availability depends on Android/Chrome/device permissions

