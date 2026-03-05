(() => {
  'use strict';

  const DB_NAME = 'sugekort_bar_local';
  const DB_VERSION = 1;

  const DEFAULT_SETTINGS = {
  clubName: 'Sugekort Bar',
  currency: 'DKK',
  operatorName: 'Bartelefon',
  adminPinHash: null,

  // V2 backend (holdes adskilt fra admin PIN)
  apiBaseUrl: '',
  apiPin: ''
};

  const state = {
    db: null,
    currentScreen: 'screenScan',
    currentCard: null,
    currentBalanceOre: 0,
    pendingRegistration: null,
    lastScannedInfo: null,
    nfcReader: null,
    scanning: false,
    nfcSupport: 'unknown',
    settings: { ...DEFAULT_SETTINGS },
  };

  const el = {};
  let toastTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
  bindElements();
  bindEvents();
  updateOnlineBadge();
  updateNfcBadge();
  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);

  try {
    state.db = await openDatabase();
    await ensureDefaultSettings();
    await loadSettingsIntoState();
    applySettingsToUI();

    window.sugekortDev = {
      apiHealth: async () => {
        return await apiGetHealth();
      },
      apiCardGet: async (cardId) => {
        return await apiPost('/card/get', { cardId });
      }
    };

    showMessage('Database klar (IndexedDB). App virker lokalt/offline efter første load.', 'success', 2500);
  } catch (err) {
    console.error(err);
    showMessage(`Databasefejl: ${err.message || err}`, 'error');
  }

  registerServiceWorker();
  setupInstallStateHints();
}
      // =========================
  // V2 API wrappers + local cache sync helpers
  // =========================

  function splitServerCardGetPayload(serverCard) {
    if (!serverCard) return { card: null, balance: null };

    const {
      balanceOre = 0,
      balanceUpdatedAt = null,
      ...cardRest
    } = serverCard;

    return {
      card: cardRest,
      balance: {
        cardId: cardRest.cardId,
        balanceOre: Number(balanceOre || 0),
        updatedAt: balanceUpdatedAt || cardRest.updatedAt || new Date().toISOString()
      }
    };
  }

  function normalizeServerCardForLocalCache(card) {
    return {
      id: `srvcard:${card.cardId}`, // undgå key-collision med gamle lokale auto IDs
      cardId: card.cardId,
      memberName: card.memberName,
      status: card.status,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt
    };
  }

  function normalizeServerTxForLocalCache(tx) {
    const localId = tx?.id != null ? `srvtx:${tx.id}` : `srvtx:${generateUuidFallback()}`;
    return {
      id: localId,
      timestamp: tx.timestamp,
      cardId: tx.cardId,
      type: tx.type,
      amountOre: Number(tx.amountOre || 0),
      balanceBeforeOre: Number(tx.balanceBeforeOre || 0),
      balanceAfterOre: Number(tx.balanceAfterOre || 0),
      operatorName: tx.operatorName || DEFAULT_SETTINGS.operatorName,
      note: tx.note || undefined,

      // gem evt. server-id til debugging/sync senere
      serverId: tx.id ?? null,
      clientTxId: tx.clientTxId ?? null
    };
  }

  async function cacheServerCardAndBalance(serverCard, serverBalance = null) {
    if (!serverCard?.cardId) return;

    const localCard = normalizeServerCardForLocalCache(serverCard);

    // hvis balance ikke blev sendt separat, prøv at bevare eksisterende lokal balance
    let localBalance = null;
    if (serverBalance && serverBalance.cardId) {
      localBalance = {
        cardId: serverBalance.cardId,
        balanceOre: Number(serverBalance.balanceOre || 0),
        updatedAt: serverBalance.updatedAt || new Date().toISOString()
      };
    }

    await runDbTransaction(['cards', 'balances'], 'readwrite', async (stores) => {
      // cards: find eksisterende record via cardId og ryd evt. gammel key (fx lokal auto-id)
      const existing = await req(stores.cards.index('cardId').get(localCard.cardId));
      if (existing && existing.id !== localCard.id) {
        await req(stores.cards.delete(existing.id));
      }

      await req(stores.cards.put(localCard));

      if (localBalance) {
        await req(stores.balances.put(localBalance));
      } else {
        // behold eksisterende balance hvis serverkaldet ikke inkluderede balance
        const existingBalance = await req(stores.balances.get(localCard.cardId));
        if (!existingBalance) {
          await req(stores.balances.put({
            cardId: localCard.cardId,
            balanceOre: 0,
            updatedAt: localCard.updatedAt || new Date().toISOString()
          }));
        }
      }
    });
  }

  async function cacheServerTransaction(serverTx) {
    if (!serverTx?.cardId) return;
    const localTx = normalizeServerTxForLocalCache(serverTx);

    await runDbTransaction(['transactions'], 'readwrite', async ({ transactions }) => {
      await req(transactions.put(localTx));
    });
  }

  async function cacheServerHistory(cardId, serverTransactions = []) {
    await runDbTransaction(['transactions'], 'readwrite', async ({ transactions }) => {
      // slet eksisterende historik for kortet
      await new Promise((resolve, reject) => {
        const index = transactions.index('cardId');
        const cursorReq = index.openCursor(IDBKeyRange.only(cardId));
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error || new Error('Kunne ikke rydde historik-cache'));
      });

      // indsæt serverhistorik
      for (const tx of serverTransactions) {
        await req(transactions.put(normalizeServerTxForLocalCache(tx)));
      }
    });
  }

  async function cacheDeleteCardData(cardId) {
    await runDbTransaction(['cards', 'balances', 'transactions'], 'readwrite', async (stores) => {
      await req(stores.balances.delete(cardId));

      const existing = await req(stores.cards.index('cardId').get(cardId));
      if (existing && typeof existing.id !== 'undefined') {
        await req(stores.cards.delete(existing.id));
      }

      await new Promise((resolve, reject) => {
        const index = stores.transactions.index('cardId');
        const cursorReq = index.openCursor(IDBKeyRange.only(cardId));
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error || new Error('Kunne ikke slette transaktioner'));
      });
    });
  }

  async function apiCardGetById(cardId) {
    return await apiPost('/card/get', { cardId });
  }

  async function apiCardRegister({ cardId, memberName, status = 'active' }) {
    return await apiPost('/card/register', { cardId, memberName, status });
  }

  async function apiCardHistory(cardId, limit = 500) {
    return await apiPost('/card/history', { cardId, limit });
  }

  async function apiCardSetStatus(cardId, status) {
    return await apiPost('/card/set-status', { cardId, status });
  }

  async function apiCardDelete(cardId) {
    return await apiPost('/card/delete', { cardId });
  }

  async function apiCardSearch(query, limit = 25) {
  return await apiPost('/card/search', { query, limit });
  }

  async function apiTxTopup({ cardId, amountOre, note, operatorName, clientTxId }) {
    return await apiPost('/tx/topup', { cardId, amountOre, note, operatorName, clientTxId });
  }

  async function apiTxPurchase({ cardId, amountOre, note, operatorName, clientTxId }) {
    return await apiPost('/tx/purchase', { cardId, amountOre, note, operatorName, clientTxId });
  }

  function bindElements() {
    const ids = [
      'clubTitle', 'offlineBadge', 'nfcBadge', 'scanState', 'scanStateTitle', 'scanStateText',
      'btnStartScan', 'btnStopScan', 'manualSearchInput', 'btnManualSearch', 'manualSearchResults',
      'btnExportJson', 'btnExportCsv', 'importJsonFile',
      'screenScan', 'screenMember', 'screenRegister', 'screenHistory', 'screenSettings',
      'memberName', 'memberStatus', 'memberBalance', 'memberCardId', 'memberUpdated',
      'btnTopup100', 'btnDeduct10', 'btnDeduct25', 'btnDeduct50', 'btnDeduct80', 'btnDeduct400', 'btnShowHistory', 'btnBackToScan',
      'adminPanel', 'adminAmountInput', 'btnAdminTopup', 'btnAdminDeduct', 'btnBlockUnblock', 'btnDeleteCard',
      'regScannedId', 'regSource', 'regGeneratedId', 'regHint', 'regMemberName', 'regActive', 'regWriteNdef',
      'btnRegisterSave', 'btnRegisterCancel',
      'historyTitle', 'historyList', 'btnHistoryExportCsv', 'btnHistoryBack',
      'settingsClubName', 'settingsOperatorName', 'settingsApiBaseUrl', 'settingsApiPin', 'settingsPin', 'btnSavePin', 'btnClearPin', 'btnSaveSettings', 'btnSettingsBack', 'btnTestApi',
      'navScan', 'navSettings', 'toast', 'messageBar'
    ];
    for (const id of ids) el[id] = document.getElementById(id);
  }

  function bindEvents() {
    el.btnStartScan.addEventListener('click', startNfcScan);
    el.btnStopScan.addEventListener('click', stopNfcScan);
    el.btnManualSearch.addEventListener('click', onManualSearch);
    el.manualSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onManualSearch();
    });

    el.btnExportJson.addEventListener('click', exportAllDataAsJson);
    el.btnExportCsv.addEventListener('click', () => exportTransactionsCsv());
    el.importJsonFile.addEventListener('change', onImportJson);

    el.btnBackToScan.addEventListener('click', () => showScreen('screenScan'));
    el.btnTopup100.addEventListener('click', () => quickActionTopup(10000));
    el.btnDeduct10.addEventListener('click', () => quickActionDeduct(1000, 'Shot / Øl / Sodavand'));
    el.btnDeduct25.addEventListener('click', () => quickActionDeduct(2000, 'Redbull / Shaker / Smirnoff'));
    el.btnDeduct50.addEventListener('click', () => quickActionDeduct(3000, 'Drink'));
    el.btnDeduct80.addEventListener('click', () => quickActionDeduct(8000, '10 shots'));
    el.btnDeduct400.addEventListener('click', () => quickActionDeduct(40000, 'Flaske m. 6 vand'));
    el.btnShowHistory.addEventListener('click', showCurrentCardHistory);
    el.btnDeleteCard.addEventListener('click', deleteCurrentCardFromDatabase);

    el.btnAdminTopup.addEventListener('click', () => adminCustomAction('topup'));
    el.btnAdminDeduct.addEventListener('click', () => adminCustomAction('deduct'));
    el.btnBlockUnblock.addEventListener('click', toggleBlockCurrentCard);

    el.btnRegisterSave.addEventListener('click', saveNewCardRegistration);
    el.btnRegisterCancel.addEventListener('click', () => {
      state.pendingRegistration = null;
      showScreen('screenScan');
    });
    el.regWriteNdef.addEventListener('change', refreshRegistrationPreview);

    el.btnHistoryBack.addEventListener('click', () => showScreen('screenMember'));
    el.btnHistoryExportCsv.addEventListener('click', () => {
      if (!state.currentCard) return;
      exportTransactionsCsv(state.currentCard.cardId);
    });

    el.navScan.addEventListener('click', () => showScreen('screenScan'));
    el.navSettings.addEventListener('click', async () => {
      await loadSettingsIntoState();
      applySettingsToUI();
      showScreen('screenSettings');
    });

    el.btnSaveSettings.addEventListener('click', saveSettings);
    el.btnSettingsBack.addEventListener('click', () => showScreen('screenScan'));
    el.btnSavePin.addEventListener('click', saveAdminPin);
    el.btnClearPin.addEventListener('click', clearAdminPin);
    el.btnTestApi.addEventListener('click', onTestApiConnection);
  }

  function showScreen(screenId) {
    for (const id of ['screenScan', 'screenMember', 'screenRegister', 'screenHistory', 'screenSettings']) {
      el[id].classList.toggle('active', id === screenId);
    }
    state.currentScreen = screenId;
    el.navScan.classList.toggle('active', screenId === 'screenScan');
    el.navSettings.classList.toggle('active', screenId === 'screenSettings');
  }

  function updateOnlineBadge() {
    const online = navigator.onLine;
    el.offlineBadge.textContent = online ? 'Online (ikke nødvendig)' : 'Offline klar';
    el.offlineBadge.className = `badge ${online ? 'badge-warn' : 'badge-success'}`;
  }

  function updateNfcBadge(kind = null) {
    if (kind) state.nfcSupport = kind;
    const supported = 'NDEFReader' in window;
    if (!supported) {
      el.nfcBadge.textContent = 'NFC ikke understøttet';
      el.nfcBadge.className = 'badge badge-danger';
      return;
    }
    if (state.scanning) {
      el.nfcBadge.textContent = 'NFC scanner aktiv';
      el.nfcBadge.className = 'badge badge-success';
      return;
    }
    el.nfcBadge.textContent = 'NFC klar';
    el.nfcBadge.className = 'badge badge-muted';
  }

  function setScanState(title, text, mode = 'neutral') {
    el.scanStateTitle.textContent = title;
    el.scanStateText.textContent = text;
    el.scanState.classList.remove('state-success', 'state-error', 'state-warn');
    if (mode === 'success') el.scanState.classList.add('state-success');
    if (mode === 'error') el.scanState.classList.add('state-error');
    if (mode === 'warn') el.scanState.classList.add('state-warn');
  }

  async function startNfcScan() {
    if (!('NDEFReader' in window)) {
      setScanState('NFC ikke understøttet', 'Denne enhed/browser understøtter ikke Web NFC i Chrome på Android.', 'error');
      showMessage('NFC ikke understøttet i denne browser/enhed.', 'error');
      return;
    }

    try {
      if (state.nfcReader && state.scanning) {
        showToast('NFC scan kører allerede');
        return;
      }

      state.nfcReader = new NDEFReader();
      await state.nfcReader.scan();
      state.scanning = true;
      updateNfcBadge();
      setScanState('Scanner…', 'Hold kortet/taggen roligt mod telefonens NFC-område.', 'neutral');
      showToast('NFC scan startet');

      state.nfcReader.onreadingerror = () => {
        setScanState('Scan fejlede', 'Kunne ikke læse tag. Prøv igen og hold kortet mere stabilt.', 'error');
        showMessage('Scan fejlede. Prøv igen.', 'error', 2200);
        vibrateError();
      };

      state.nfcReader.onreading = async (event) => {
        try {
          const scanInfo = parseCardScan(event);
          state.lastScannedInfo = scanInfo;
          if (!scanInfo.cardId) {
            const msg = scanInfo.error || 'Ukendt/understøttet tagformat';
            setScanState('Tag ikke understøttet', msg, 'error');
            showMessage(msg, 'error', 3200);
            vibrateError();
            return;
          }
          await handleScannedCard(scanInfo);
        } catch (err) {
          console.error('NFC read handler error:', err);
          setScanState('NFC fejl', err.message || 'Uventet fejl ved håndtering af scan.', 'error');
          showMessage(`NFC fejl: ${err.message || err}`, 'error');
          vibrateError();
        }
      };
    } catch (err) {
      console.error(err);
      state.scanning = false;
      updateNfcBadge();
      let message = 'NFC permission denied eller scan kunne ikke startes.';
      if (String(err?.message || '').toLowerCase().includes('notallowed')) {
        message = 'NFC tilladelse blev afvist.';
      }
      setScanState('Kan ikke starte scan', message, 'error');
      showMessage(message, 'error');
    }
  }

  function stopNfcScan() {
    // Web NFC har ikke en officiel stop()-API i Chrome. Vi nulstiller handlers lokalt.
    if (state.nfcReader) {
      state.nfcReader.onreading = null;
      state.nfcReader.onreadingerror = null;
    }
    state.scanning = false;
    updateNfcBadge();
    setScanState('Scan stoppet', 'Tryk “Start NFC scan” for at scanne igen.', 'warn');
    showToast('NFC scan stoppet');
  }

  function parseCardScan(event) {
    const info = {
      cardId: null,
      source: null,
      serialNumber: event.serialNumber || null,
      rawRecordCount: event.message?.records?.length ?? 0,
      error: null,
    };

    const records = event.message?.records || [];
    for (const record of records) {
      if (record.recordType === 'text') {
        const text = decodeNdefTextRecord(record);
        const normalized = normalizeCardId(text);
        if (normalized) {
          info.cardId = normalized;
          info.source = 'ndef-text';
          return info;
        }
      }

      // Fallback: some tags may contain unknown/plain payloads
      if (record.data) {
        try {
          const raw = new TextDecoder().decode(record.data);
          const normalized = normalizeCardId(raw);
          if (normalized) {
            info.cardId = normalized;
            info.source = `record-${record.recordType || 'unknown'}`;
            return info;
          }
        } catch {
          // ignore undecodable record
        }
      }
    }

    if (event.serialNumber) {
      info.cardId = `SERIAL:${String(event.serialNumber).trim()}`;
      info.source = 'serial-fallback';
      return info;
    }

    if (records.length > 0) {
      info.error = 'Tag læst, men ingen understøttet tekst-ID blev fundet (NDEF text forventes).';
    } else {
      info.error = 'Tom tag eller ukendt format. Prøv at registrere og skrive et nyt NDEF-ID.';
    }
    return info;
  }

  function decodeNdefTextRecord(record) {
    // NDEF text record payload format: [status-byte][lang-code][text-bytes]
    const view = record.data;
    if (!view) return '';
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (bytes.length === 0) return '';

    const status = bytes[0];
    const isUtf16 = (status & 0x80) !== 0;
    const langLen = status & 0x3f;
    const textBytes = bytes.slice(1 + langLen);
    try {
      return new TextDecoder(isUtf16 ? 'utf-16' : 'utf-8').decode(textBytes).trim();
    } catch {
      try {
        return new TextDecoder().decode(textBytes).trim();
      } catch {
        return '';
      }
    }
  }

  function normalizeCardId(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    let out = trimmed;
    if (/^sugekort:/i.test(out)) out = out.replace(/^sugekort:/i, '').trim();
    if (!out) return null;
    if (out.length > 180) return null;
    return out;
  }

     async function handleScannedCard(scanInfo) {
    const cardId = scanInfo.cardId;
    setScanState('Kort læst', `ID: ${cardId}`, 'success');

    // V2: server-first lookup hvis API er konfigureret
    if (hasApiConfig()) {
      try {
        const resp = await apiCardGetById(cardId);

        if (resp?.found && resp.card) {
          const { card: serverCard, balance: serverBalance } = splitServerCardGetPayload(resp.card);
          await cacheServerCardAndBalance(serverCard, serverBalance);

          const cachedCard = await getCardByCardId(cardId);
          if (cachedCard) {
            await loadCardIntoMemberScreen(cachedCard);
            showScreen('screenMember');
            showMessage(`${cachedCard.memberName} fundet (server)`, 'success', 1500);
            vibrateSuccess();
            return;
          }
        }

        // Ikke fundet på server -> normal registreringsflow
        prepareRegistration(scanInfo);
        showScreen('screenRegister');
        showMessage('Kort ikke fundet. Opret nyt kort.', 'warn', 2200);
        vibrateSuccess();
        return;
      } catch (err) {
        console.error('API card/get fejl:', err);
        showMessage(`Serveropslag fejlede: ${err.message || err}`, 'error', 3000);
        vibrateError();
        return; // strict online lookup når API er sat op
      }
    }

    // Fallback: lokal-only (gammel adfærd)
    const card = await getCardByCardId(cardId);
    if (card) {
      await loadCardIntoMemberScreen(card);
      showScreen('screenMember');
      showMessage(`${card.memberName} fundet`, 'success', 1500);
      vibrateSuccess();
      return;
    }

    prepareRegistration(scanInfo);
    showScreen('screenRegister');
    showMessage('Kort ikke fundet. Opret nyt kort.', 'warn', 2200);
    vibrateSuccess();
  }

  function prepareRegistration(scanInfo) {
  const generatedId = crypto.randomUUID ? crypto.randomUUID() : generateUuidFallback();
  state.pendingRegistration = {
    scanInfo,
    generatedId,
  };

  el.regScannedId.textContent = scanInfo.cardId || 'Ukendt';
  el.regSource.textContent = formatSourceLabel(scanInfo.source);
  el.regGeneratedId.textContent = generatedId;
  el.regMemberName.value = '';
  el.regActive.checked = true;
  el.regWriteNdef.checked = scanInfo.source !== 'ndef-text';
  el.regWriteNdef.disabled = scanInfo.source === 'ndef-text';
  el.regMemberName.focus();
  refreshRegistrationPreview();
}

  function formatSourceLabel(source) {
  switch (source) {
    case 'ndef-text': return 'NDEF tekst (anbefalet)';
    case 'serial-fallback': return 'Serienummer fallback';
    default: return source || 'Ukendt';
  }
}

function refreshRegistrationPreview() {
  const pending = state.pendingRegistration;
  if (!pending) return;

  const { scanInfo, generatedId } = pending;
  const shouldWrite = !!el.regWriteNdef.checked && scanInfo.source !== 'ndef-text';

  const finalCardId = scanInfo.source === 'ndef-text'
    ? scanInfo.cardId
    : (shouldWrite ? generatedId : scanInfo.cardId);

  let hint = `Kortet vil blive gemt med ID: ${finalCardId}. `;
  if (scanInfo.source === 'ndef-text') {
    hint += 'Kortet har allerede et NDEF tekst-ID.';
  } else if (shouldWrite) {
    hint += 'Du skal holde kortet til telefonen igen, så appen kan skrive nyt NDEF-ID.';
  } else {
    hint += 'Bemærk: du bruger serienummer-fallback. Det virker ofte, men NDEF-ID er mere robust til denne app.';
  }

  el.regHint.textContent = hint;
}

async function saveNewCardRegistration() {
  if (!state.pendingRegistration) {
    showMessage('Ingen registrering i gang.', 'error');
    return;
  }

  const memberName = el.regMemberName.value.trim();
  if (!memberName) {
    showMessage('Skriv medlemsnavn først.', 'error');
    el.regMemberName.focus();
    return;
  }

  const { scanInfo, generatedId } = state.pendingRegistration;
  const active = el.regActive.checked;
  const writeNdef = !!el.regWriteNdef.checked && scanInfo.source !== 'ndef-text';
  let finalCardId = scanInfo.cardId;

  if (writeNdef) {
    finalCardId = generatedId;
    try {
      await writeCardIdToNdef(finalCardId);
      showToast('NDEF-ID skrevet til kort');
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke skrive NDEF-ID: ${err.message || err}`, 'error');
      return;
    }
  }

  // V2: server-first register hvis API er konfigureret
  if (hasApiConfig()) {
    try {
      const resp = await apiCardRegister({
        cardId: finalCardId,
        memberName,
        status: active ? 'active' : 'blocked'
      });

      if (!resp?.ok || !resp.card) {
        throw new Error('Ugyldigt svar fra server');
      }

      await cacheServerCardAndBalance(resp.card, resp.balance || null);

      state.pendingRegistration = null;
      setScanState('Kort oprettet', `${memberName} blev oprettet`, 'success');
      showMessage('Kort oprettet ✅', 'success', 1800);

      const cachedCard = await getCardByCardId(finalCardId);
      if (cachedCard) {
        await loadCardIntoMemberScreen(cachedCard);
        showScreen('screenMember');
      } else {
        showScreen('screenScan');
      }

      vibrateSuccess();
      return;
    } catch (err) {
      console.error('API card/register fejl:', err);
      if (err.status === 409) {
        showMessage('Kort-ID findes allerede i fælles database.', 'error');
      } else {
        showMessage(`Kunne ikke gemme kort på server: ${err.message || err}`, 'error');
      }
      return;
    }
  }

  // Fallback: lokal-only (gammel adfærd)
  try {
    const existing = await getCardByCardId(finalCardId);
    if (existing) {
      showMessage('Kort-ID findes allerede i databasen.', 'error');
      return;
    }

    const now = new Date().toISOString();
    const cardData = {
      cardId: finalCardId,
      memberName,
      status: active ? 'active' : 'blocked',
      createdAt: now,
      updatedAt: now,
    };

    await createCardWithBalance(cardData, 0);

    state.pendingRegistration = null;
    setScanState('Kort oprettet', `${memberName} blev oprettet`, 'success');
    showMessage('Kort oprettet ✅', 'success', 1800);

    const card = await getCardByCardId(finalCardId);
    if (card) {
      await loadCardIntoMemberScreen(card);
      showScreen('screenMember');
    } else {
      showScreen('screenScan');
    }

    vibrateSuccess();
  } catch (err) {
    console.error(err);
    showMessage(`Kunne ikke gemme kort: ${err.message || err}`, 'error');
  }
}

  async function writeCardIdToNdef(cardId) {
    if (!('NDEFReader' in window)) {
      throw new Error('Web NFC er ikke tilgængelig');
    }
    const writer = new NDEFReader();
    // User should have tag near the device and this call is triggered via button press (user gesture)
    await writer.write(cardId);
  }

  async function loadCardIntoMemberScreen(card) {
    const balance = await getBalanceByCardId(card.cardId);
    const balanceOre = balance?.balanceOre ?? 0;

    state.currentCard = card;
    state.currentBalanceOre = balanceOre;

    el.memberName.textContent = card.memberName;
    el.memberCardId.textContent = card.cardId;
    el.memberBalance.textContent = formatOre(balanceOre);
    el.memberUpdated.textContent = formatDateTime(balance?.updatedAt || card.updatedAt || card.createdAt);
    el.memberStatus.textContent = card.status === 'blocked' ? 'Blokeret' : 'Aktiv';
    el.memberStatus.className = `badge ${card.status === 'blocked' ? 'badge-danger' : 'badge-success'}`;
    el.btnBlockUnblock.textContent = card.status === 'blocked' ? 'Ophæv blokering' : 'Blokér kort';

    const isBlocked = card.status === 'blocked';
[
  el.btnTopup100,
  el.btnDeduct10,
  el.btnDeduct25,
  el.btnDeduct50,
  el.btnDeduct80,
  el.btnDeduct400
].filter(Boolean).forEach(btn => btn.disabled = isBlocked);

el.btnAdminTopup.disabled = false;
el.btnAdminDeduct.disabled = false;
}
  async function quickActionTopup(amountOre) {
    if (!state.currentCard) return;
    const ok = confirm(`Top-up ${formatOre(amountOre)} til ${state.currentCard.memberName}?`);
    if (!ok) return;
    await applyBalanceChange({
      cardId: state.currentCard.cardId,
      type: 'topup',
      deltaOre: amountOre,
      note: 'Quick top-up',
      requireActiveCard: true,
      adminMode: false,
    });
  }

  async function quickActionDeduct(amountOre, productLabel = 'Køb') {
  if (!state.currentCard) return;

  const ok = confirm(
    `Træk ${formatOre(amountOre)} (${productLabel}) fra ${state.currentCard.memberName}?`
  );
  if (!ok) return;

  await applyBalanceChange({
    cardId: state.currentCard.cardId,
    type: 'purchase',
    deltaOre: -Math.abs(amountOre),
    note: `Køb · ${productLabel}`,
    requireActiveCard: true,
    adminMode: false,
  });
}

  async function adminCustomAction(mode) {
    if (!state.currentCard) return;
    const passed = await ensureAdminAccess();
    if (!passed) return;

    const raw = el.adminAmountInput.value.trim().replace(',', '.');
    const amountKr = Number(raw);
    if (!Number.isFinite(amountKr) || amountKr <= 0) {
      showMessage('Indtast et gyldigt beløb i kr (fx 12.50).', 'error');
      return;
    }
    const amountOre = Math.round(amountKr * 100);
    const isTopup = mode === 'topup';
    const actionLabel = isTopup ? 'top-up' : 'træk';
    const ok = confirm(`Admin ${actionLabel} ${formatOre(amountOre)}?`);
    if (!ok) return;

    await applyBalanceChange({
      cardId: state.currentCard.cardId,
      type: isTopup ? 'adjustment' : 'adjustment',
      deltaOre: isTopup ? amountOre : -amountOre,
      note: `Admin ${actionLabel}`,
      requireActiveCard: !isTopup,
      adminMode: true,
    });
  }

    async function toggleBlockCurrentCard() {
    if (!state.currentCard) return;

    const passed = await ensureAdminAccess();
    if (!passed) return;

    const targetStatus = state.currentCard.status === 'blocked' ? 'active' : 'blocked';
    const ok = confirm(`${targetStatus === 'blocked' ? 'Blokér' : 'Ophæv blokering af'} kort for ${state.currentCard.memberName}?`);
    if (!ok) return;

    if (hasApiConfig()) {
      try {
        const resp = await apiCardSetStatus(state.currentCard.cardId, targetStatus);
        if (!resp?.card) throw new Error('Ugyldigt svar fra server');

        // bevar lokal balance-cache, opdatér card fra server
        await cacheServerCardAndBalance(resp.card, {
          cardId: state.currentCard.cardId,
          balanceOre: state.currentBalanceOre ?? 0,
          updatedAt: new Date().toISOString()
        });

        const freshCard = await getCardByCardId(state.currentCard.cardId);
        if (freshCard) await loadCardIntoMemberScreen(freshCard);

        showMessage(`Kort ${targetStatus === 'blocked' ? 'blokeret' : 'genaktiveret'}.`, 'success', 1800);
        vibrateSuccess();
      } catch (err) {
        console.error(err);
        showMessage(`Kunne ikke opdatere kortstatus på server: ${err.message || err}`, 'error');
        vibrateError();
      }
      return;
    }

    // Fallback: lokal-only
    try {
      state.currentCard.status = targetStatus;
      state.currentCard.updatedAt = new Date().toISOString();
      await putCard(state.currentCard);
      await loadCardIntoMemberScreen(state.currentCard);
      showMessage(`Kort ${targetStatus === 'blocked' ? 'blokeret' : 'genaktiveret'}.`, 'success', 1800);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke opdatere kortstatus: ${err.message || err}`, 'error');
      vibrateError();
    }
  }

    async function deleteCurrentCardFromDatabase() {
    if (!state.currentCard) {
      showMessage('Intet kort valgt.', 'error');
      return;
    }

    const passed = await ensureAdminAccess();
    if (!passed) return;

    const card = state.currentCard;
    const balanceOre = state.currentBalanceOre ?? 0;

    const isServerMode = hasApiConfig();
    const ok = confirm(
      `Slet kort fra database?\n\n` +
      `Navn: ${card.memberName}\n` +
      `Kort ID: ${card.cardId}\n` +
      `Saldo: ${formatOre(balanceOre)}\n\n` +
      (isServerMode
        ? `Dette sletter kort, saldo og AL historik i FÆLLES database (alle enheder).`
        : `Dette sletter kort, saldo og AL historik permanent på denne telefon.`)
    );
    if (!ok) return;

    if (isServerMode) {
      try {
        await apiCardDelete(card.cardId);
        await cacheDeleteCardData(card.cardId);

        state.currentCard = null;
        state.currentBalanceOre = 0;

        setScanState('Kort slettet', 'Kortet og tilknyttet data er slettet fra fælles database.', 'success');
        showScreen('screenScan');
        showMessage('Kort slettet fra fælles database ✅', 'success', 2200);
        vibrateSuccess();
      } catch (err) {
        console.error(err);
        showMessage(`Kunne ikke slette kort på server: ${err.message || err}`, 'error');
        vibrateError();
      }
      return;
    }

    // Fallback: lokal-only
    try {
      await runDbTransaction(['cards', 'balances', 'transactions'], 'readwrite', async (stores) => {
        await req(stores.balances.delete(card.cardId));

        if (typeof card.id !== 'undefined' && card.id !== null) {
          await req(stores.cards.delete(card.id));
        } else {
          const existing = await req(stores.cards.index('cardId').get(card.cardId));
          if (existing && typeof existing.id !== 'undefined') {
            await req(stores.cards.delete(existing.id));
          }
        }

        await new Promise((resolve, reject) => {
          const index = stores.transactions.index('cardId');
          const cursorReq = index.openCursor(IDBKeyRange.only(card.cardId));

          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            } else {
              resolve();
            }
          };

          cursorReq.onerror = () => {
            reject(cursorReq.error || new Error('Kunne ikke slette transaktioner'));
          };
        });
      });

      state.currentCard = null;
      state.currentBalanceOre = 0;

      setScanState('Kort slettet', 'Kortet og tilknyttet data er slettet fra databasen.', 'success');
      showScreen('screenScan');
      showMessage('Kort slettet fra database ✅', 'success', 2200);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke slette kort: ${err.message || err}`, 'error');
      vibrateError();
    }
  }

    async function applyBalanceChange({ cardId, type, deltaOre, note = '', requireActiveCard = true, adminMode = false }) {
  // V2: server-first hvis API er konfigureret
  if (hasApiConfig()) {
    try {
      const amountOre = Math.abs(Number(deltaOre || 0));
      if (!Number.isInteger(amountOre) || amountOre <= 0) {
        showMessage('Ugyldigt beløb.', 'error');
        vibrateError();
        return;
      }

      const operatorName = state.settings.operatorName || DEFAULT_SETTINGS.operatorName;
      const clientTxId = crypto.randomUUID ? crypto.randomUUID() : generateUuidFallback();

      const isPositive = deltaOre >= 0;
      let result;

      // Backend har ikke separat "adjustment"-endpoint endnu.
      // Admin justeringer mappes derfor til topup/purchase med note.
      if (isPositive) {
        result = await apiTxTopup({
          cardId,
          amountOre,
          note,
          operatorName,
          clientTxId
        });
      } else {
        result = await apiTxPurchase({
          cardId,
          amountOre,
          note,
          operatorName,
          clientTxId
        });
      }

      // Cache server-resultat
      if (result?.card) {
        await cacheServerCardAndBalance(result.card, result.balance || null);
      } else {
        // fx duplicate reply uden card/balance -> hent aktuel state
        const lookup = await apiCardGetById(cardId);
        if (lookup?.found && lookup.card) {
          const split = splitServerCardGetPayload(lookup.card);
          await cacheServerCardAndBalance(split.card, split.balance);
        }
      }

      if (result?.transaction) {
        await cacheServerTransaction(result.transaction);
      }

      if (state.currentCard && state.currentCard.cardId === cardId) {
        const freshCard = await getCardByCardId(cardId);
        if (freshCard) {
          await loadCardIntoMemberScreen(freshCard);
        }
      }

      const afterOre =
        result?.balance?.balanceOre ??
        result?.transaction?.balanceAfterOre ??
        (await getBalanceByCardId(cardId))?.balanceOre ??
        0;

      const cardForName = await getCardByCardId(cardId);
      const memberName = cardForName?.memberName || cardId;

      showMessage(
        `${isPositive ? 'Top-up/justering gennemført' : 'Træk gennemført'} · Ny saldo: ${formatOre(afterOre)}`,
        'success',
        2200
      );
      setScanState('Handling gennemført', `${memberName}: ${formatOre(afterOre)}`, 'success');
      showToast(`${isPositive ? '+' : '-'} ${formatOre(amountOre)}`);
      vibrateSuccess();
      return;
    } catch (err) {
      console.error('API saldoændring fejl:', err);
      const payload = err?.payload || {};

      if (payload?.code === 'INSUFFICIENT_BALANCE') {
        showMessage(`Ikke nok saldo. Aktuel saldo: ${formatOre(payload.beforeOre ?? 0)}`, 'error');
      } else if (payload?.code === 'CARD_BLOCKED') {
        showMessage('Kortet er blokeret.', 'error');
      } else {
        showMessage(`Serverfejl ved saldoændring: ${err.message || err}`, 'error');
      }
      vibrateError();
      return;
    }
  }

  // Fallback: lokal-only (gammel adfærd)
  try {
    const card = await getCardByCardId(cardId);
    if (!card) throw new Error('Kort findes ikke');
    if (requireActiveCard && card.status === 'blocked') {
      showMessage('Kortet er blokeret.', 'error');
      vibrateError();
      return;
    }

    const result = await runDbTransaction(['balances', 'transactions', 'cards', 'settings'], 'readwrite', async (stores) => {
      const balanceRecord = await req(stores.balances.get(cardId));
      const before = balanceRecord?.balanceOre ?? 0;
      const after = before + deltaOre;

      if (!adminMode && after < 0) {
        const err = new Error('Insufficient balance');
        err.code = 'INSUFFICIENT_BALANCE';
        err.beforeOre = before;
        throw err;
      }

      const now = new Date().toISOString();
      const updatedBalance = { cardId, balanceOre: after, updatedAt: now };
      await req(stores.balances.put(updatedBalance));

      card.updatedAt = now;
      await req(stores.cards.put(card));

      const operatorName = await readSettingFromStore(stores.settings, 'operatorName', DEFAULT_SETTINGS.operatorName);
      const tx = {
        timestamp: now,
        cardId,
        type,
        amountOre: Math.abs(deltaOre),
        balanceBeforeOre: before,
        balanceAfterOre: after,
        operatorName,
        note: note || undefined,
      };
      await req(stores.transactions.add(tx));

      return { beforeOre: before, afterOre: after, tx };
    });

    if (state.currentCard && state.currentCard.cardId === cardId) {
      const freshCard = await getCardByCardId(cardId);
      await loadCardIntoMemberScreen(freshCard);
    }

    const isPositive = deltaOre >= 0;
    showMessage(
      `${isPositive ? 'Top-up/justering gennemført' : 'Træk gennemført'} · Ny saldo: ${formatOre(result.afterOre)}`,
      'success',
      2200
    );
    setScanState('Handling gennemført', `${card.memberName}: ${formatOre(result.afterOre)}`, 'success');
    showToast(`${isPositive ? '+' : '-'} ${formatOre(Math.abs(deltaOre))}`);
    vibrateSuccess();
  } catch (err) {
    console.error(err);
    if (err.code === 'INSUFFICIENT_BALANCE') {
      showMessage(`Ikke nok saldo. Aktuel saldo: ${formatOre(err.beforeOre ?? 0)}`, 'error');
    } else {
      showMessage(`Databasefejl ved saldoændring: ${err.message || err}`, 'error');
    }
    vibrateError();
  }
}

async function showCurrentCardHistory() {
  if (!state.currentCard) return;

  if (hasApiConfig()) {
    try {
      const resp = await apiCardHistory(state.currentCard.cardId);
      const txs = Array.isArray(resp?.transactions) ? resp.transactions : [];

      // cache til lokal DB, så resten af appen stadig kan bruge samme struktur
      await cacheServerHistory(state.currentCard.cardId, txs);

      el.historyTitle.textContent = `Historik · ${state.currentCard.memberName}`;
      renderHistoryList(txs); // render direkte fra server-shape (matcher allerede)
      showScreen('screenHistory');
      return;
    } catch (err) {
      console.error('API card/history fejl:', err);
      showMessage(`Kunne ikke hente historik fra server: ${err.message || err}`, 'error');
      return;
    }
  }

  // Fallback: lokal-only
  try {
    const txs = await getTransactionsForCard(state.currentCard.cardId);
    el.historyTitle.textContent = `Historik · ${state.currentCard.memberName}`;
    renderHistoryList(txs);
    showScreen('screenHistory');
  } catch (err) {
    console.error(err);
    showMessage(`Kunne ikke hente historik: ${err.message || err}`, 'error');
  }
}

  function renderHistoryList(txs) {
    el.historyList.innerHTML = '';
    if (!txs.length) {
      el.historyList.innerHTML = '<div class="list-item muted">Ingen transaktioner endnu.</div>';
      return;
    }

    for (const tx of txs.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))) {
      const row = document.createElement('div');
      row.className = 'list-item';

      const sign = tx.type === 'purchase' ? '-' : '+';
      const isMinus = tx.type === 'purchase';
      const note = tx.note ? ` · ${escapeHtml(tx.note)}` : '';
      const typeLabel = typeToLabel(tx.type);

      row.innerHTML = `
        <div class="tx-row">
          <div>
            <div><strong>${typeLabel}</strong>${note}</div>
            <div class="meta">${escapeHtml(formatDateTime(tx.timestamp))} · ${escapeHtml(tx.operatorName || 'Bartelefon')}</div>
            <div class="meta">${formatOre(tx.balanceBeforeOre)} → ${formatOre(tx.balanceAfterOre)}</div>
          </div>
          <div class="tx-amount ${isMinus ? 'minus' : 'plus'}">${sign}${formatOre(tx.amountOre)}</div>
        </div>
      `;
      el.historyList.appendChild(row);
    }
  }

  function typeToLabel(type) {
    switch (type) {
      case 'topup': return 'Top-up';
      case 'purchase': return 'Køb';
      case 'refund': return 'Refund';
      case 'adjustment': return 'Justering';
      default: return type || 'Ukendt';
    }
  }

  async function onManualSearch() {
  const query = el.manualSearchInput.value.trim();

  // Server-first hvis API er sat op
  if (hasApiConfig()) {
    try {
      const resp = await apiCardSearch(query, 50);
      const serverCards = Array.isArray(resp?.cards) ? resp.cards : [];

      // cache resultater lokalt (så resten af appen kan bruge samme flow)
      for (const row of serverCards) {
        const { card, balance } = splitServerCardGetPayload(row);
        await cacheServerCardAndBalance(card, balance);
      }

      // hent fra lokal cache til render (ensartet shape)
      const localResults = await searchCards(query);
      renderManualResults(localResults);

      if (!localResults.length) {
        showMessage('Ingen resultater fra server.', 'warn', 1800);
      }
      return;
    } catch (err) {
      console.error('API card/search fejl:', err);
      showMessage(`Serversøgning fejlede: ${err.message || err}`, 'error', 2500);
      // fallback til lokal søgning
    }
  }

  // Lokal fallback
  const results = await searchCards(query);
  renderManualResults(results);
}

  function renderManualResults(results) {
    el.manualSearchResults.innerHTML = '';
    if (!results.length) {
      el.manualSearchResults.innerHTML = '<div class="list-item muted">Ingen resultater.</div>';
      return;
    }
    for (const card of results) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'list-item clickable';
      item.innerHTML = `
        <div><strong>${escapeHtml(card.memberName)}</strong> <span class="tiny muted">(${escapeHtml(card.status)})</span></div>
        <div class="tiny muted">${escapeHtml(card.cardId)}</div>
      `;
      item.addEventListener('click', async () => {
        await loadCardIntoMemberScreen(card);
        showScreen('screenMember');
      });
      el.manualSearchResults.appendChild(item);
    }
  }

  async function saveSettings() {
  try {
    const clubName = el.settingsClubName.value.trim() || DEFAULT_SETTINGS.clubName;
    const operatorName = el.settingsOperatorName.value.trim() || DEFAULT_SETTINGS.operatorName;

    const apiBaseUrl = el.settingsApiBaseUrl.value.trim();
    const apiPin = el.settingsApiPin.value.trim();

    await setSetting('clubName', clubName);
    await setSetting('operatorName', operatorName);
    await setSetting('apiBaseUrl', apiBaseUrl);
    await setSetting('apiPin', apiPin);

    await loadSettingsIntoState();
    applySettingsToUI();
    showMessage('Indstillinger gemt.', 'success', 1500);
  } catch (err) {
    console.error(err);
    showMessage(`Kunne ikke gemme indstillinger: ${err.message || err}`, 'error');
  }
}

  async function onTestApiConnection() {
  try {
    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      return;
    }

    const health = await apiGetHealth();
    showMessage(`API OK ✅ DB: ${health.db}`, 'success', 2200);
    showToast('API forbindelse virker', 'success');
    vibrateSuccess();
  } catch (err) {
    console.error(err);
    showMessage(`API test fejlede: ${err.message || err}`, 'error', 3500);
    vibrateError();
  }
}

  async function saveAdminPin() {
    const pin = el.settingsPin.value.trim();
    if (!/^\d{4,}$/.test(pin)) {
      showMessage('PIN skal være mindst 4 cifre.', 'error');
      return;
    }
    try {
      const hash = await sha256Hex(pin);
      await setSetting('adminPinHash', hash);
      el.settingsPin.value = '';
      await loadSettingsIntoState();
      showMessage('Admin PIN gemt.', 'success', 1500);
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke gemme PIN: ${err.message || err}`, 'error');
    }
  }

  async function clearAdminPin() {
    const ok = confirm('Fjern admin PIN? Admin-handlinger vil ikke længere kræve PIN.');
    if (!ok) return;
    try {
      await setSetting('adminPinHash', null);
      await loadSettingsIntoState();
      showMessage('Admin PIN fjernet.', 'success', 1500);
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke fjerne PIN: ${err.message || err}`, 'error');
    }
  }

  async function ensureAdminAccess() {
    const hash = state.settings.adminPinHash;
    if (!hash) return true;
    const pin = prompt('Indtast admin PIN');
    if (pin == null) return false;
    const pinHash = await sha256Hex(String(pin).trim());
    if (pinHash !== hash) {
      showMessage('Forkert admin PIN.', 'error');
      vibrateError();
      return false;
    }
    return true;
  }

  function applySettingsToUI() {
  el.clubTitle.textContent = state.settings.clubName || DEFAULT_SETTINGS.clubName;
  el.settingsClubName.value = state.settings.clubName || DEFAULT_SETTINGS.clubName;
  el.settingsOperatorName.value = state.settings.operatorName || DEFAULT_SETTINGS.operatorName;

  el.settingsApiBaseUrl.value = state.settings.apiBaseUrl || '';
  el.settingsApiPin.value = state.settings.apiPin || '';
}

  async function loadSettingsIntoState() {
    const all = await getAllSettings();
    state.settings = { ...DEFAULT_SETTINGS, ...all };
  }

  async function ensureDefaultSettings() {
    const current = await getAllSettings();
    const entries = Object.entries(DEFAULT_SETTINGS);
    for (const [key, value] of entries) {
      if (!(key in current)) {
        await setSetting(key, value);
      }
    }
  }

  async function exportAllDataAsJson() {
    try {
      const payload = await exportDatabaseJson();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const filename = `sugekort-backup-${timestampForFilename()}.json`;
      downloadBlob(blob, filename);
      showMessage('JSON backup eksporteret.', 'success', 1800);
    } catch (err) {
      console.error(err);
      showMessage(`Eksportfejl (JSON): ${err.message || err}`, 'error');
    }
  }

  async function exportTransactionsCsv(cardId = null) {
    try {
      const rows = cardId ? await getTransactionsForCard(cardId) : await getAllTransactions();
      const csv = transactionsToCsv(rows);
      const suffix = cardId ? `-${sanitizeFilename(cardId)}` : '-alle';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `sugekort-transaktioner${suffix}-${timestampForFilename()}.csv`);
      showMessage('CSV eksport klar.', 'success', 1800);
    } catch (err) {
      console.error(err);
      showMessage(`Eksportfejl (CSV): ${err.message || err}`, 'error');
    }
  }

  async function onImportJson(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      validateBackupPayload(data);
      const ok = confirm('Import vil overskrive AL lokal data på denne telefon. Fortsæt?');
      if (!ok) return;

      await importDatabaseJson(data);
      await loadSettingsIntoState();
      applySettingsToUI();
      state.currentCard = null;
      renderManualResults([]);
      showScreen('screenScan');
      showMessage('Backup importeret ✅', 'success', 2500);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Importfejl: ${err.message || err}`, 'error');
      vibrateError();
    }
  }

  function validateBackupPayload(data) {
    if (!data || typeof data !== 'object') throw new Error('Ugyldigt JSON backup-format');
    for (const key of ['cards', 'balances', 'transactions', 'settings']) {
      if (!Array.isArray(data[key])) throw new Error(`Backup mangler array: ${key}`);
    }
  }

  function transactionsToCsv(rows) {
    const header = [
      'timestamp', 'cardId', 'type', 'amountOre', 'amountKr', 'balanceBeforeOre', 'balanceAfterOre', 'operatorName', 'note'
    ];
    const lines = [header.join(';')];
    for (const tx of rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))) {
      const vals = [
        tx.timestamp,
        tx.cardId,
        tx.type,
        tx.amountOre,
        oreToCsvKr(tx.amountOre),
        tx.balanceBeforeOre,
        tx.balanceAfterOre,
        tx.operatorName || 'Bartelefon',
        tx.note || ''
      ].map(csvEscape);
      lines.push(vals.join(';'));
    }
    return lines.join('\n');
  }

  function oreToCsvKr(ore) {
    return (Number(ore || 0) / 100).toFixed(2).replace('.', ',');
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[;"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showToast(text, kind = '') {
    el.toast.textContent = text;
    el.toast.className = `toast show ${kind}`.trim();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast';
    }, 1800);
  }

  function showMessage(text, type = 'warn', timeoutMs = 3200) {
    el.messageBar.textContent = text;
    el.messageBar.className = `message-bar ${type}`;
    el.messageBar.classList.remove('hidden');
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (el.messageBar.textContent === text) el.messageBar.classList.add('hidden');
      }, timeoutMs);
    }
  }

  function vibrateSuccess() {
    if (navigator.vibrate) navigator.vibrate(40);
  }

  function vibrateError() {
    if (navigator.vibrate) navigator.vibrate([70, 40, 70]);
  }

  function formatOre(ore) {
    const val = Number(ore || 0) / 100;
    return `${val.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
  }

  function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('da-DK', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function timestampForFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function sanitizeFilename(s) {
    return String(s).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function generateUuidFallback() {
    // Simple fallback if crypto.randomUUID is unavailable
    const tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return tpl.replace(/[xy]/g, (c) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      const v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  async function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

    function getApiConfig() {
    const baseUrl = String(state.settings.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const apiPin = String(state.settings.apiPin || '').trim();
    return { baseUrl, apiPin };
  }

  function hasApiConfig() {
    const { baseUrl, apiPin } = getApiConfig();
    return !!baseUrl && !!apiPin;
  }

  async function apiPost(path, body) {
    const { baseUrl, apiPin } = getApiConfig();

    if (!baseUrl) throw new Error('API base URL mangler');
    if (!apiPin) throw new Error('API PIN mangler');

    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bar-Pin': apiPin
      },
      body: JSON.stringify(body ?? {})
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore non-json
    }

    if (!res.ok) {
      const err = new Error(data?.error || `API fejl (${res.status})`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }

    return data;
  }

  async function apiGetHealth() {
    const { baseUrl } = getApiConfig();

    if (!baseUrl) throw new Error('API base URL mangler');

    const url = `${baseUrl}/health`;
    const res = await fetch(url, { method: 'GET' });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore non-json
    }

    if (!res.ok) {
      const err = new Error(data?.error || `Health fejl (${res.status})`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }

    return data;
  }
  
  function setupInstallStateHints() {
    // Not critical for MVP; keep simple. We only expose offline/installed behavior via manifest + SW.
    window.addEventListener('appinstalled', () => {
      showToast('App installeret 🎉', 'success');
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.debug('SW registered', reg);
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  // =========================
  // IndexedDB layer
  // =========================

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;
        if (oldVersion < 1) {
          const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
          cards.createIndex('cardId', 'cardId', { unique: true });
          cards.createIndex('memberName', 'memberName', { unique: false });
          cards.createIndex('status', 'status', { unique: false });

          const balances = db.createObjectStore('balances', { keyPath: 'cardId' });
          balances.createIndex('updatedAt', 'updatedAt', { unique: false });

          const txs = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          txs.createIndex('cardId', 'cardId', { unique: false });
          txs.createIndex('timestamp', 'timestamp', { unique: false });
          txs.createIndex('cardId_timestamp', ['cardId', 'timestamp'], { unique: false });

          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Kunne ikke åbne IndexedDB'));
      request.onblocked = () => reject(new Error('Database er blokeret af en anden fane/app-instans'));
    });
  }

  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function txComplete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function runDbTransaction(storeNames, mode, callback) {
    const tx = state.db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
    let callbackResult;
    try {
      callbackResult = await callback(stores, tx);
    } catch (err) {
      try { tx.abort(); } catch {}
      throw err;
    }
    await txComplete(tx);
    return callbackResult;
  }

  async function getCardByCardId(cardId) {
    return runDbTransaction(['cards'], 'readonly', async ({ cards }) => {
      const idx = cards.index('cardId');
      return await req(idx.get(cardId));
    });
  }

  async function putCard(card) {
    return runDbTransaction(['cards'], 'readwrite', async ({ cards }) => {
      await req(cards.put(card));
    });
  }

  async function createCardWithBalance(card, initialBalanceOre = 0) {
    const now = new Date().toISOString();
    return runDbTransaction(['cards', 'balances'], 'readwrite', async ({ cards, balances }) => {
      await req(cards.add(card));
      await req(balances.put({ cardId: card.cardId, balanceOre: initialBalanceOre, updatedAt: now }));
    });
  }

  async function getBalanceByCardId(cardId) {
    return runDbTransaction(['balances'], 'readonly', async ({ balances }) => {
      return await req(balances.get(cardId));
    });
  }

  async function getTransactionsForCard(cardId) {
    return runDbTransaction(['transactions'], 'readonly', async ({ transactions }) => {
      const index = transactions.index('cardId');
      return await req(index.getAll(cardId));
    });
  }

  async function getAllTransactions() {
    return runDbTransaction(['transactions'], 'readonly', async ({ transactions }) => {
      return await req(transactions.getAll());
    });
  }

  async function searchCards(query) {
    return runDbTransaction(['cards'], 'readonly', async ({ cards }) => {
      const all = await req(cards.getAll());
      const q = (query || '').trim().toLowerCase();
      if (!q) {
        return all.sort((a, b) => String(a.memberName).localeCompare(String(b.memberName), 'da'));
      }
      return all.filter(c =>
        String(c.memberName || '').toLowerCase().includes(q) ||
        String(c.cardId || '').toLowerCase().includes(q)
      ).sort((a, b) => String(a.memberName).localeCompare(String(b.memberName), 'da'));
    });
  }

  async function getAllSettings() {
    return runDbTransaction(['settings'], 'readonly', async ({ settings }) => {
      const rows = await req(settings.getAll());
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    });
  }

  async function setSetting(key, value) {
    return runDbTransaction(['settings'], 'readwrite', async ({ settings }) => {
      await req(settings.put({ key, value, updatedAt: new Date().toISOString() }));
    });
  }

  async function readSettingFromStore(settingsStore, key, fallback) {
    const row = await req(settingsStore.get(key));
    return row ? row.value : fallback;
  }

  async function exportDatabaseJson() {
    return runDbTransaction(['cards', 'balances', 'transactions', 'settings'], 'readonly', async (stores) => {
      const [cards, balances, transactions, settings] = await Promise.all([
        req(stores.cards.getAll()),
        req(stores.balances.getAll()),
        req(stores.transactions.getAll()),
        req(stores.settings.getAll()),
      ]);

      return {
        meta: {
          app: 'sugekort-bar-pwa',
          version: 1,
          exportedAt: new Date().toISOString(),
        },
        cards,
        balances,
        transactions,
        settings,
      };
    });
  }

  async function importDatabaseJson(data) {
    await runDbTransaction(['cards', 'balances', 'transactions', 'settings'], 'readwrite', async (stores) => {
      await Promise.all([
        req(stores.cards.clear()),
        req(stores.balances.clear()),
        req(stores.transactions.clear()),
        req(stores.settings.clear()),
      ]);

      for (const row of data.cards) await req(stores.cards.put(row));
      for (const row of data.balances) await req(stores.balances.put(row));
      for (const row of data.transactions) await req(stores.transactions.put(row));
      for (const row of data.settings) await req(stores.settings.put(row));
    });
  }

})();
