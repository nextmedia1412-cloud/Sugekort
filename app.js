(() => {
  'use strict';

  // =========================================================
  // Server-only mode
  // - Ingen kort/saldo/historik gemmes lokalt på telefonen.
  // - Kun indstillinger gemmes lokalt (localStorage).
  // - Hvis du tidligere har kørt local-mode, sletter vi den gamle IndexedDB automatisk.
  // =========================================================

  const DB_NAME = 'sugekort_bar_local'; // gammel DB (til sletning)
  const SETTINGS_KEY = 'sugekort_settings_v2';

  const DEFAULT_SETTINGS = {
    clubName: 'Sugekort Bar',
    currency: 'DKK',
    operatorName: 'Bartelefon',
    adminPinHash: null,

    // Backend
    apiBaseUrl: '', // fx https://xxx.ts.net/api
    apiPin: ''      // sendes som X-Bar-Pin header
  };

  const state = {
    currentScreen: 'screenScan',
    currentCard: null,          // { cardId, memberName, status, createdAt, updatedAt }
    currentBalanceOre: 0,
    pendingRegistration: null,
    lastScannedInfo: null,
    nfcReader: null,
    scanning: false,
    settings: { ...DEFAULT_SETTINGS },
  };

  const el = {};
  let toastTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindElements();
    bindEvents();

    // UI badges
    updateOnlineBadge();
    updateNfcBadge();
    window.addEventListener('online', updateOnlineBadge);
    window.addEventListener('offline', updateOnlineBadge);

    // Indstillinger (lokalt)
    await loadSettingsIntoState();
    applySettingsToUI();

    // Slet gammel lokal DB (kort/saldo/historik) hvis den findes
    await deleteLegacyIndexedDb();

    // Dev helpers
    window.sugekortDev = {
      apiHealth: async () => apiGetHealth(),
      apiCardGet: async (cardId) => apiPost('/card/get', { cardId }),
      wipeLegacyDb: async () => deleteLegacyIndexedDb(true),
    };

    showMessage('App klar. Data hentes fra server.', 'success', 2200);

    registerServiceWorker();
    setupInstallStateHints();
  }

  // =========================================================
  // Settings (localStorage)
  // =========================================================

  async function loadSettingsIntoState() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      state.settings = { ...DEFAULT_SETTINGS, ...(parsed || {}) };
    } catch {
      state.settings = { ...DEFAULT_SETTINGS };
    }
  }

  async function persistSettingsFromState() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function applySettingsToUI() {
    el.clubTitle.textContent = state.settings.clubName || DEFAULT_SETTINGS.clubName;
    el.settingsClubName.value = state.settings.clubName || DEFAULT_SETTINGS.clubName;
    el.settingsOperatorName.value = state.settings.operatorName || DEFAULT_SETTINGS.operatorName;

    if (el.settingsApiBaseUrl) el.settingsApiBaseUrl.value = state.settings.apiBaseUrl || '';
    if (el.settingsApiPin) el.settingsApiPin.value = state.settings.apiPin || '';
  }

  async function saveSettings() {
    try {
      state.settings.clubName = (el.settingsClubName.value.trim() || DEFAULT_SETTINGS.clubName);
      state.settings.operatorName = (el.settingsOperatorName.value.trim() || DEFAULT_SETTINGS.operatorName);

      // API
      if (el.settingsApiBaseUrl) state.settings.apiBaseUrl = el.settingsApiBaseUrl.value.trim();
      if (el.settingsApiPin) state.settings.apiPin = el.settingsApiPin.value.trim();

      await persistSettingsFromState();
      await loadSettingsIntoState(); // normaliser
      applySettingsToUI();

      showMessage('Indstillinger gemt.', 'success', 1500);
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke gemme indstillinger: ${err.message || err}`, 'error');
    }
  }

  // =========================================================
  // Online badge (grøn online, rød offline)
  // =========================================================

  function updateOnlineBadge() {
    const online = navigator.onLine;
    el.offlineBadge.textContent = online ? 'Online' : 'Offline';
    el.offlineBadge.className = `badge ${online ? 'badge-success' : 'badge-danger'}`;
  }

  // =========================================================
  // NFC badge
  // =========================================================

  function updateNfcBadge() {
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

  // =========================================================
  // Screen navigation
  // =========================================================

  function showScreen(screenId) {
    for (const id of ['screenScan', 'screenMember', 'screenRegister', 'screenHistory', 'screenSettings']) {
      el[id].classList.toggle('active', id === screenId);
    }
    state.currentScreen = screenId;
    el.navScan.classList.toggle('active', screenId === 'screenScan');
    el.navSettings.classList.toggle('active', screenId === 'screenSettings');
  }

  // =========================================================
  // Bindings
  // =========================================================

  function bindElements() {
    const ids = [
      'clubTitle', 'offlineBadge', 'nfcBadge', 'scanState', 'scanStateTitle', 'scanStateText',
      'btnStartScan', 'btnStopScan', 'manualSearchInput', 'btnManualSearch', 'manualSearchResults',
      'btnExportJson', 'btnExportCsv', 'importJsonFile',
      'screenScan', 'screenMember', 'screenRegister', 'screenHistory', 'screenSettings',
      'memberName', 'memberStatus', 'memberBalance', 'memberCardId', 'memberUpdated',
      'btnTopup100', 'btnDeduct10', 'btnDeduct25', 'btnDeduct50', 'btnDeduct80', 'btnDeduct400',
      'btnShowHistory', 'btnBackToScan',
      'adminPanel', 'adminAmountInput', 'btnAdminTopup', 'btnAdminDeduct', 'btnBlockUnblock', 'btnDeleteCard',
      'regScannedId', 'regSource', 'regGeneratedId', 'regHint', 'regMemberName', 'regActive', 'regWriteNdef',
      'btnRegisterSave', 'btnRegisterCancel',
      'historyTitle', 'historyList', 'btnHistoryExportCsv', 'btnHistoryBack',
      'settingsClubName', 'settingsOperatorName', 'settingsApiBaseUrl', 'settingsApiPin',
      'settingsPin', 'btnSavePin', 'btnClearPin', 'btnSaveSettings', 'btnSettingsBack', 'btnTestApi',
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

    // Eksport/import (lokal DB findes ikke længere)
    if (el.btnExportJson) el.btnExportJson.addEventListener('click', () => {
      showMessage('Server-mode: JSON eksport er ikke koblet på endnu.', 'warn', 3000);
    });
    if (el.btnExportCsv) el.btnExportCsv.addEventListener('click', () => {
      showMessage('Server-mode: Brug historik på et kort og eksportér derfra.', 'warn', 3200);
    });
    if (el.importJsonFile) el.importJsonFile.addEventListener('change', (e) => {
      e.target.value = '';
      showMessage('Server-mode: Import er slået fra.', 'warn', 3000);
    });

    el.btnBackToScan.addEventListener('click', () => showScreen('screenScan'));

    // Quick actions (topup/purchase)
    if (el.btnTopup100) el.btnTopup100.addEventListener('click', () => quickActionTopup(10000));
    if (el.btnDeduct10) el.btnDeduct10.addEventListener('click', () => quickActionDeduct(1000, 'Shot / Øl / Sodavand'));
    if (el.btnDeduct25) el.btnDeduct25.addEventListener('click', () => quickActionDeduct(2000, 'Redbull / Shaker / Smirnoff'));
    if (el.btnDeduct50) el.btnDeduct50.addEventListener('click', () => quickActionDeduct(3000, 'Drink'));
    if (el.btnDeduct80) el.btnDeduct80.addEventListener('click', () => quickActionDeduct(8000, '10 shots'));
    if (el.btnDeduct400) el.btnDeduct400.addEventListener('click', () => quickActionDeduct(40000, 'Flaske m. 6 vand'));

    if (el.btnShowHistory) el.btnShowHistory.addEventListener('click', showCurrentCardHistory);
    if (el.btnDeleteCard) el.btnDeleteCard.addEventListener('click', deleteCurrentCardFromDatabase);

    if (el.btnAdminTopup) el.btnAdminTopup.addEventListener('click', () => adminCustomAction('topup'));
    if (el.btnAdminDeduct) el.btnAdminDeduct.addEventListener('click', () => adminCustomAction('deduct'));
    if (el.btnBlockUnblock) el.btnBlockUnblock.addEventListener('click', toggleBlockCurrentCard);

    if (el.btnRegisterSave) el.btnRegisterSave.addEventListener('click', saveNewCardRegistration);
    if (el.btnRegisterCancel) el.btnRegisterCancel.addEventListener('click', () => {
      state.pendingRegistration = null;
      showScreen('screenScan');
    });
    if (el.regWriteNdef) el.regWriteNdef.addEventListener('change', refreshRegistrationPreview);

    if (el.btnHistoryBack) el.btnHistoryBack.addEventListener('click', () => showScreen('screenMember'));
    if (el.btnHistoryExportCsv) el.btnHistoryExportCsv.addEventListener('click', async () => {
      if (!state.currentCard) return;
      await exportTransactionsCsv(state.currentCard.cardId);
    });

    el.navScan.addEventListener('click', () => showScreen('screenScan'));
    el.navSettings.addEventListener('click', async () => {
      await loadSettingsIntoState();
      applySettingsToUI();
      showScreen('screenSettings');
    });

    if (el.btnSaveSettings) el.btnSaveSettings.addEventListener('click', saveSettings);
    if (el.btnSettingsBack) el.btnSettingsBack.addEventListener('click', () => showScreen('screenScan'));
    if (el.btnSavePin) el.btnSavePin.addEventListener('click', saveAdminPin);
    if (el.btnClearPin) el.btnClearPin.addEventListener('click', clearAdminPin);
    if (el.btnTestApi) el.btnTestApi.addEventListener('click', onTestApiConnection);
  }

  // =========================================================
  // Status box
  // =========================================================

  function setScanState(title, text, mode = 'neutral') {
    el.scanStateTitle.textContent = title;
    el.scanStateText.textContent = text;
    el.scanState.classList.remove('state-success', 'state-error', 'state-warn');
    if (mode === 'success') el.scanState.classList.add('state-success');
    if (mode === 'error') el.scanState.classList.add('state-error');
    if (mode === 'warn') el.scanState.classList.add('state-warn');
  }

  // =========================================================
  // NFC scanning
  // =========================================================

  async function startNfcScan() {
    if (!('NDEFReader' in window)) {
      setScanState('NFC ikke understøttet', 'Denne enhed/browser understøtter ikke Web NFC i Chrome på Android.', 'error');
      showMessage('NFC ikke understøttet i denne browser/enhed.', 'error');
      return;
    }

    if (!hasApiConfig()) {
      showMessage('Indtast API base URL + API PIN under Indstillinger først.', 'error', 3500);
      showScreen('screenSettings');
      return;
    }

    if (!navigator.onLine) {
      showMessage('Offline: kan ikke hente data fra server.', 'error', 3000);
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
      if (String(err?.message || '').toLowerCase().includes('notallowed')) message = 'NFC tilladelse blev afvist.';
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
        } catch { /* ignore */ }
      }
    }

    if (event.serialNumber) {
      info.cardId = `SERIAL:${String(event.serialNumber).trim()}`;
      info.source = 'serial-fallback';
      return info;
    }

    info.error = records.length > 0
      ? 'Tag læst, men ingen understøttet tekst-ID blev fundet (NDEF text forventes).'
      : 'Tom tag eller ukendt format. Prøv at registrere og skrive et nyt NDEF-ID.';
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
      try { return new TextDecoder().decode(textBytes).trim(); } catch { return ''; }
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

    try {
      const resp = await apiCardGetById(cardId);

      if (resp?.found && resp.card) {
        const { card, balance } = splitServerCardGetPayload(resp.card);
        await loadCardIntoMemberScreen(card, balance);
        showScreen('screenMember');
        showMessage(`${card.memberName} fundet`, 'success', 1500);
        vibrateSuccess();
        return;
      }

      // Ikke fundet på server -> registrering
      prepareRegistration(scanInfo);
      showScreen('screenRegister');
      showMessage('Kort ikke fundet. Opret nyt kort.', 'warn', 2200);
      vibrateSuccess();
    } catch (err) {
      console.error('API card/get fejl:', err);
      showMessage(`Serveropslag fejlede: ${err.message || err}`, 'error', 3000);
      vibrateError();
    }
  }

  // =========================================================
  // Registration
  // =========================================================

  function prepareRegistration(scanInfo) {
    const generatedId = crypto.randomUUID ? crypto.randomUUID() : generateUuidFallback();
    state.pendingRegistration = { scanInfo, generatedId };

    el.regScannedId.textContent = scanInfo.cardId || 'Ukendt';
    el.regSource.textContent = formatSourceLabel(scanInfo.source);
    el.regGeneratedId.textContent = generatedId;

    el.regMemberName.value = '';
    el.regActive.checked = true;

    // hvis tag ikke allerede er NDEF text, foreslå at skrive nyt ID
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
      hint += 'Hold kortet til telefonen igen, så appen kan skrive nyt NDEF-ID.';
    } else {
      hint += 'Bemærk: du bruger serienummer-fallback. NDEF-ID er mere robust til denne app.';
    }

    el.regHint.textContent = hint;
  }

  async function saveNewCardRegistration() {
    if (!state.pendingRegistration) {
      showMessage('Ingen registrering i gang.', 'error');
      return;
    }

    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
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

    try {
      const resp = await apiCardRegister({
        cardId: finalCardId,
        memberName,
        status: active ? 'active' : 'blocked'
      });

      if (!resp?.ok || !resp.card) throw new Error('Ugyldigt svar fra server');

      const { card, balance } = splitServerCardGetPayload(resp.card);
      state.pendingRegistration = null;

      setScanState('Kort oprettet', `${memberName} blev oprettet`, 'success');
      showMessage('Kort oprettet ✅', 'success', 1800);

      await loadCardIntoMemberScreen(card, balance);
      showScreen('screenMember');
      vibrateSuccess();
    } catch (err) {
      console.error('API card/register fejl:', err);
      if (err.status === 409) {
        showMessage('Kort-ID findes allerede i fælles database.', 'error');
      } else {
        showMessage(`Kunne ikke gemme kort på server: ${err.message || err}`, 'error');
      }
    }
  }

  async function writeCardIdToNdef(cardId) {
    if (!('NDEFReader' in window)) throw new Error('Web NFC er ikke tilgængelig');
    const writer = new NDEFReader();
    await writer.write(cardId);
  }

  // =========================================================
  // Member screen + actions
  // =========================================================

  async function loadCardIntoMemberScreen(card, balance) {
    state.currentCard = card;
    state.currentBalanceOre = Number(balance?.balanceOre ?? 0);

    el.memberName.textContent = card.memberName || '—';
    el.memberCardId.textContent = card.cardId || '—';
    el.memberBalance.textContent = formatOre(state.currentBalanceOre);

    const updatedTs = balance?.updatedAt || card.updatedAt || card.createdAt || null;
    el.memberUpdated.textContent = formatDateTime(updatedTs);

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

    if (el.btnAdminTopup) el.btnAdminTopup.disabled = false;
    if (el.btnAdminDeduct) el.btnAdminDeduct.disabled = false;
  }

  async function refreshCurrentCardFromServer() {
    if (!state.currentCard?.cardId) return;
    const resp = await apiCardGetById(state.currentCard.cardId);
    if (!resp?.found || !resp.card) throw new Error('Kort findes ikke længere');
    const { card, balance } = splitServerCardGetPayload(resp.card);
    await loadCardIntoMemberScreen(card, balance);
  }

  async function quickActionTopup(amountOre) {
    if (!state.currentCard) return;
    const ok = confirm(`Top-up ${formatOre(amountOre)} til ${state.currentCard.memberName}?`);
    if (!ok) return;

    await applyBalanceChange({
      deltaOre: amountOre,
      note: 'Quick top-up'
    });
  }

  async function quickActionDeduct(amountOre, productLabel = 'Køb') {
    if (!state.currentCard) return;
    const ok = confirm(`Træk ${formatOre(amountOre)} (${productLabel}) fra ${state.currentCard.memberName}?`);
    if (!ok) return;

    await applyBalanceChange({
      deltaOre: -Math.abs(amountOre),
      note: `Køb · ${productLabel}`
    });
  }

  async function adminCustomAction(mode) {
    if (!state.currentCard) return;
    const passed = await ensureAdminAccess();
    if (!passed) return;

    const raw = (el.adminAmountInput?.value || '').trim().replace(',', '.');
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
      deltaOre: isTopup ? amountOre : -amountOre,
      note: `Admin ${actionLabel}`
    });
  }

  async function applyBalanceChange({ deltaOre, note = '' }) {
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke gennemføre handling.', 'error', 2500);
      vibrateError();
      return;
    }
    if (!state.currentCard?.cardId) return;

    const amountOre = Math.abs(Number(deltaOre || 0));
    if (!Number.isInteger(amountOre) || amountOre <= 0) {
      showMessage('Ugyldigt beløb.', 'error');
      vibrateError();
      return;
    }

    try {
      const operatorName = state.settings.operatorName || DEFAULT_SETTINGS.operatorName;
      const clientTxId = crypto.randomUUID ? crypto.randomUUID() : generateUuidFallback();
      const isPositive = deltaOre >= 0;

      if (isPositive) {
        await apiTxTopup({
          cardId: state.currentCard.cardId,
          amountOre,
          note,
          operatorName,
          clientTxId
        });
      } else {
        await apiTxPurchase({
          cardId: state.currentCard.cardId,
          amountOre,
          note,
          operatorName,
          clientTxId
        });
      }

      await refreshCurrentCardFromServer();

      showMessage(
        `${isPositive ? 'Top-up/justering gennemført' : 'Træk gennemført'} · Ny saldo: ${formatOre(state.currentBalanceOre)}`,
        'success',
        2200
      );
      setScanState('Handling gennemført', `${state.currentCard.memberName}: ${formatOre(state.currentBalanceOre)}`, 'success');
      showToast(`${isPositive ? '+' : '-'} ${formatOre(amountOre)}`);
      vibrateSuccess();
    } catch (err) {
      console.error('API saldoændring fejl:', err);
      const payload = err?.payload || {};
      if (payload?.code === 'INSUFFICIENT_BALANCE') {
        showMessage(`Ikke nok saldo. Aktuel saldo: ${formatOre(payload.beforeOre ?? state.currentBalanceOre ?? 0)}`, 'error');
      } else if (payload?.code === 'CARD_BLOCKED') {
        showMessage('Kortet er blokeret.', 'error');
      } else {
        showMessage(`Serverfejl ved saldoændring: ${err.message || err}`, 'error');
      }
      vibrateError();
    }
  }

  async function toggleBlockCurrentCard() {
    if (!state.currentCard) return;
    const passed = await ensureAdminAccess();
    if (!passed) return;

    const targetStatus = state.currentCard.status === 'blocked' ? 'active' : 'blocked';
    const ok = confirm(`${targetStatus === 'blocked' ? 'Blokér' : 'Ophæv blokering af'} kort for ${state.currentCard.memberName}?`);
    if (!ok) return;

    try {
      await apiCardSetStatus(state.currentCard.cardId, targetStatus);
      await refreshCurrentCardFromServer();
      showMessage(`Kort ${targetStatus === 'blocked' ? 'blokeret' : 'genaktiveret'}.`, 'success', 1800);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke opdatere kortstatus på server: ${err.message || err}`, 'error');
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

    const ok = confirm(
      `Slet kort fra fælles database?\n\n` +
      `Navn: ${state.currentCard.memberName}\n` +
      `Kort ID: ${state.currentCard.cardId}\n` +
      `Saldo: ${formatOre(state.currentBalanceOre)}\n\n` +
      `Dette sletter kort, saldo og AL historik i FÆLLES database (alle enheder).`
    );
    if (!ok) return;

    try {
      await apiCardDelete(state.currentCard.cardId);

      state.currentCard = null;
      state.currentBalanceOre = 0;

      setScanState('Kort slettet', 'Kortet og tilknyttet data er slettet fra fælles database.', 'success');
      showScreen('screenScan');
      showMessage('Kort slettet ✅', 'success', 2200);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke slette kort på server: ${err.message || err}`, 'error');
      vibrateError();
    }
  }

  // =========================================================
  // History + export
  // =========================================================

  async function showCurrentCardHistory() {
    if (!state.currentCard) return;

    if (!navigator.onLine) {
      showMessage('Offline: kan ikke hente historik.', 'error', 2500);
      return;
    }

    try {
      const resp = await apiCardHistory(state.currentCard.cardId, 500);
      const txs = Array.isArray(resp?.transactions) ? resp.transactions : (Array.isArray(resp) ? resp : []);
      el.historyTitle.textContent = `Historik · ${state.currentCard.memberName}`;
      renderHistoryList(txs);
      showScreen('screenHistory');
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke hente historik fra server: ${err.message || err}`, 'error');
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

  async function exportTransactionsCsv(cardId) {
    try {
      if (!navigator.onLine) {
        showMessage('Offline: kan ikke eksportere.', 'error', 2400);
        return;
      }
      const resp = await apiCardHistory(cardId, 5000);
      const rows = Array.isArray(resp?.transactions) ? resp.transactions : [];
      const csv = transactionsToCsv(rows);

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `sugekort-transaktioner-${sanitizeFilename(cardId)}-${timestampForFilename()}.csv`);
      showMessage('CSV eksport klar.', 'success', 1800);
    } catch (err) {
      console.error(err);
      showMessage(`Eksportfejl (CSV): ${err.message || err}`, 'error');
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

  // =========================================================
  // Manual search (server)
  // =========================================================

  async function onManualSearch() {
    const query = el.manualSearchInput.value.trim();
    if (!query) {
      renderManualResults([]);
      return;
    }
    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
      return;
    }
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke søge.', 'error', 2400);
      return;
    }

    try {
      const resp = await apiCardSearch(query);
      const results = Array.isArray(resp?.cards) ? resp.cards
        : Array.isArray(resp?.results) ? resp.results
        : Array.isArray(resp) ? resp
        : [];
      renderManualResults(results);
    } catch (err) {
      console.error(err);
      showMessage(`Søgning fejlede: ${err.message || err}`, 'error', 2600);
    }
  }

  function renderManualResults(results) {
    el.manualSearchResults.innerHTML = '';
    if (!results.length) {
      el.manualSearchResults.innerHTML = '<div class="list-item muted">Ingen resultater.</div>';
      return;
    }

    for (const c of results) {
      const cardId = c.cardId || c.card_id || '';
      const memberName = c.memberName || c.member_name || cardId || '—';
      const status = c.status || 'active';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'list-item clickable';
      item.innerHTML = `
        <div><strong>${escapeHtml(memberName)}</strong> <span class="tiny muted">(${escapeHtml(status)})</span></div>
        <div class="tiny muted">${escapeHtml(cardId)}</div>
      `;

      item.addEventListener('click', async () => {
        try {
          const resp = await apiCardGetById(cardId);
          if (resp?.found && resp.card) {
            const { card, balance } = splitServerCardGetPayload(resp.card);
            await loadCardIntoMemberScreen(card, balance);
            showScreen('screenMember');
          } else {
            showMessage('Kort findes ikke længere.', 'error');
          }
        } catch (err) {
          console.error(err);
          showMessage(`Kunne ikke åbne kort: ${err.message || err}`, 'error');
        }
      });

      el.manualSearchResults.appendChild(item);
    }
  }

  // =========================================================
  // Admin PIN (lokalt)
  // =========================================================

  async function saveAdminPin() {
    const pin = (el.settingsPin?.value || '').trim();
    if (!/^\d{4,}$/.test(pin)) {
      showMessage('PIN skal være mindst 4 cifre.', 'error');
      return;
    }
    try {
      state.settings.adminPinHash = await sha256Hex(pin);
      if (el.settingsPin) el.settingsPin.value = '';
      await persistSettingsFromState();
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
      state.settings.adminPinHash = null;
      await persistSettingsFromState();
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

  // =========================================================
  // API client
  // =========================================================

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
    try { data = await res.json(); } catch { /* ignore */ }

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
    try { data = await res.json(); } catch { /* ignore */ }

    if (!res.ok) {
      const err = new Error(data?.error || `Health fejl (${res.status})`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
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

  async function apiTxTopup({ cardId, amountOre, note, operatorName, clientTxId }) {
    return await apiPost('/tx/topup', { cardId, amountOre, note, operatorName, clientTxId });
  }

  async function apiTxPurchase({ cardId, amountOre, note, operatorName, clientTxId }) {
    return await apiPost('/tx/purchase', { cardId, amountOre, note, operatorName, clientTxId });
  }

  async function apiCardSearch(query, limit = 50) {
    // send både "query" og "q" for at være robust mod backend-navne
    return await apiPost('/card/search', { query, q: query, limit });
  }

  // =========================================================
  // Server payload helpers
  // =========================================================

  function splitServerCardGetPayload(serverCard) {
    if (!serverCard) return { card: null, balance: null };

    const {
      balanceOre = 0,
      balanceUpdatedAt = null,
      ...cardRest
    } = serverCard;

    const card = {
      cardId: cardRest.cardId ?? cardRest.card_id,
      memberName: cardRest.memberName ?? cardRest.member_name,
      status: cardRest.status,
      createdAt: cardRest.createdAt ?? cardRest.created_at,
      updatedAt: cardRest.updatedAt ?? cardRest.updated_at,
    };

    return {
      card,
      balance: {
        cardId: card.cardId,
        balanceOre: Number(balanceOre || 0),
        updatedAt: balanceUpdatedAt || card.updatedAt || card.createdAt || new Date().toISOString()
      }
    };
  }

  // =========================================================
  // Legacy IndexedDB removal (kort/saldo/historik)
  // =========================================================

  async function deleteLegacyIndexedDb(verbose = false) {
    if (!('indexedDB' in window)) return;

    // Hvis den aldrig har eksisteret, er det en no-op.
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    if (verbose) showMessage('Gammel lokal DB forsøgt slettet (IndexedDB).', 'success', 2000);
  }

  // =========================================================
  // UX helpers
  // =========================================================

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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function generateUuidFallback() {
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

  function setupInstallStateHints() {
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

})();
