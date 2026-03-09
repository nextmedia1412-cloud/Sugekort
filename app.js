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
    catalogItems: [],
    itemEditorId: null,
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

    await runStartupApiCheck();
    await refreshCatalogFromServer({ silent: true });

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
      await refreshCatalogFromServer({ silent: true });
      resetItemEditor();

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
      'dynamicActionGrid', 'actionGridEmpty',
      'btnShowHistory', 'btnBackToScan',
      'adminPanel', 'adminAmountInput', 'btnAdminTopup', 'btnAdminDeduct', 'btnBlockUnblock', 'btnDeleteCard',
      'regScannedId', 'regSource', 'regGeneratedId', 'regHint', 'regMemberName', 'regActive', 'regWriteNdef',
      'btnRegisterSave', 'btnRegisterCancel',
      'historyTitle', 'historyList', 'btnHistoryExportCsv', 'btnHistoryBack',
      'settingsClubName', 'settingsOperatorName', 'settingsApiBaseUrl', 'settingsApiPin',
      'settingsPin', 'btnSavePin', 'btnClearPin', 'btnSaveSettings', 'btnSettingsBack', 'btnTestApi',
      'itemEditorMode', 'settingsItemName', 'settingsItemAmount', 'settingsItemType', 'settingsItemButtonText',
      'settingsItemStyle', 'settingsItemActive', 'btnItemSave', 'btnItemEditorReset', 'settingsItemsList',
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

    // Eksport/import (fælles serverdata)
    if (el.btnExportJson) el.btnExportJson.addEventListener('click', exportServerBackupJson);
    if (el.btnExportCsv) el.btnExportCsv.addEventListener('click', exportServerBackupCsv);
    if (el.importJsonFile) el.importJsonFile.addEventListener('change', onImportBackupJsonSelected);

    el.btnBackToScan.addEventListener('click', () => showScreen('screenScan'));
    renderMemberActionButtons();

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
      await refreshCatalogFromServer({ silent: true });
      resetItemEditor();
      showScreen('screenSettings');
    });

    if (el.btnItemSave) el.btnItemSave.addEventListener('click', saveCatalogItemFromEditor);
    if (el.btnItemEditorReset) el.btnItemEditorReset.addEventListener('click', resetItemEditor);
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
  // Server catalog (varer & knapper)
  // =========================================================

  function defaultCatalogButtonText({ name = '', amountOre = 0, type = 'purchase' } = {}) {
    const action = type === 'topup' ? 'Top-Up +' : 'Træk -';
    const suffix = name ? ` (${name})` : '';
    return `${action}${formatOre(amountOre)}${suffix}`;
  }

  function normalizeCatalogItems(resp) {
    const raw = Array.isArray(resp?.items) ? resp.items : (Array.isArray(resp) ? resp : []);
    return raw.map((item) => ({
      id: Number(item?.id),
      name: String(item?.name || '').trim(),
      amountOre: Number(item?.amountOre || 0),
      type: String(item?.type || 'purchase').trim().toLowerCase() === 'topup' ? 'topup' : 'purchase',
      buttonText: String(item?.buttonText || '').trim(),
      style: String(item?.style || '').trim().toLowerCase() || 'secondary',
      active: Boolean(item?.active),
      sortOrder: Number(item?.sortOrder || 0),
      createdAt: item?.createdAt || null,
      updatedAt: item?.updatedAt || null
    })).filter((item) => Number.isInteger(item.id) && item.id > 0)
      .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  }

  function getSortedCatalogItems(items = state.catalogItems) {
    return [...(Array.isArray(items) ? items : [])].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  }

  function getItemButtonClass(style = 'secondary') {
    switch (style) {
      case 'primary': return 'btn btn-primary btn-lg';
      case 'success': return 'btn btn-success btn-lg';
      case 'danger': return 'btn btn-danger btn-lg';
      case 'ghost': return 'btn btn-ghost btn-lg';
      default: return 'btn btn-secondary btn-lg';
    }
  }

  async function refreshCatalogFromServer({ silent = false } = {}) {
    if (!hasApiConfig()) {
      state.catalogItems = [];
      renderMemberActionButtons();
      renderSettingsItemsList();
      return [];
    }
    if (!navigator.onLine) {
      renderMemberActionButtons();
      renderSettingsItemsList();
      if (!silent) showMessage('Offline: kan ikke hente varer fra serveren.', 'error', 2600);
      return state.catalogItems;
    }

    try {
      const resp = await apiItemsList();
      state.catalogItems = normalizeCatalogItems(resp);
      renderMemberActionButtons();
      renderSettingsItemsList();
      return state.catalogItems;
    } catch (err) {
      console.error('Kunne ikke hente varer:', err);
      renderMemberActionButtons();
      renderSettingsItemsList();
      if (!silent) showMessage(`Kunne ikke hente varer fra serveren: ${err.message || err}`, 'error', 3500);
      return state.catalogItems;
    }
  }

  function renderMemberActionButtons() {
    if (!el.dynamicActionGrid) return;

    const items = getSortedCatalogItems().filter((item) => item.active);
    const isBlocked = state.currentCard?.status === 'blocked';
    const hasCard = !!state.currentCard;

    el.dynamicActionGrid.innerHTML = '';
    if (el.actionGridEmpty) el.actionGridEmpty.hidden = items.length > 0;

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = getItemButtonClass(item.style);
      btn.textContent = item.buttonText || defaultCatalogButtonText(item);
      btn.disabled = !hasCard || isBlocked;
      btn.addEventListener('click', () => runCatalogItemAction(item));
      el.dynamicActionGrid.appendChild(btn);
    }
  }

  async function runCatalogItemAction(item) {
    if (!state.currentCard || !item) return;

    const isTopup = item.type === 'topup';
    const actionLabel = isTopup ? 'Top-up' : 'Træk';
    const itemLabel = item.name || item.buttonText || 'vare';
    const ok = confirm(`${actionLabel} ${formatOre(item.amountOre)} (${itemLabel}) ${isTopup ? 'til' : 'fra'} ${state.currentCard.memberName}?`);
    if (!ok) return;

    await applyBalanceChange({
      deltaOre: isTopup ? Math.abs(item.amountOre) : -Math.abs(item.amountOre),
      note: `${isTopup ? 'Top-up' : 'Køb'} · ${itemLabel}`
    });
  }

  function resetItemEditor() {
    state.itemEditorId = null;
    if (el.itemEditorMode) el.itemEditorMode.textContent = 'Ny vare';
    if (el.settingsItemName) el.settingsItemName.value = '';
    if (el.settingsItemAmount) el.settingsItemAmount.value = '';
    if (el.settingsItemType) el.settingsItemType.value = 'purchase';
    if (el.settingsItemButtonText) el.settingsItemButtonText.value = '';
    if (el.settingsItemStyle) el.settingsItemStyle.value = 'danger';
    if (el.settingsItemActive) el.settingsItemActive.checked = true;
  }

  function fillItemEditor(item) {
    if (!item) return;
    state.itemEditorId = Number(item.id);
    if (el.itemEditorMode) el.itemEditorMode.textContent = `Redigerer vare #${item.id}`;
    if (el.settingsItemName) el.settingsItemName.value = item.name || '';
    if (el.settingsItemAmount) el.settingsItemAmount.value = (Number(item.amountOre || 0) / 100).toFixed(2).replace(/\.00$/, '');
    if (el.settingsItemType) el.settingsItemType.value = item.type === 'topup' ? 'topup' : 'purchase';
    if (el.settingsItemButtonText) el.settingsItemButtonText.value = item.buttonText || '';
    if (el.settingsItemStyle) el.settingsItemStyle.value = item.style || (item.type === 'topup' ? 'success' : 'danger');
    if (el.settingsItemActive) el.settingsItemActive.checked = Boolean(item.active);
  }

  function getCatalogItemFromEditor() {
    const name = (el.settingsItemName?.value || '').trim();
    const amountRaw = String(el.settingsItemAmount?.value || '').trim().replace(',', '.');
    const amountKr = Number(amountRaw);
    const amountOre = Math.round(amountKr * 100);
    const type = (el.settingsItemType?.value || 'purchase').trim().toLowerCase() === 'topup' ? 'topup' : 'purchase';
    const buttonTextRaw = (el.settingsItemButtonText?.value || '').trim();
    const style = (el.settingsItemStyle?.value || (type === 'topup' ? 'success' : 'danger')).trim();
    const active = Boolean(el.settingsItemActive?.checked);

    return {
      name,
      amountOre,
      type,
      buttonText: buttonTextRaw || defaultCatalogButtonText({ name, amountOre, type }),
      style,
      active
    };
  }

  function validateCatalogItemPayload(item) {
    if (!item.name) return 'Varenavn mangler.';
    if (!Number.isInteger(item.amountOre) || item.amountOre <= 0) return 'Beløb skal være større end 0.';
    if (!['topup', 'purchase'].includes(item.type)) return 'Type er ugyldig.';
    if (!item.buttonText) return 'Knaptekst kunne ikke dannes.';
    return null;
  }

  async function saveCatalogItemFromEditor() {
    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
      return;
    }
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke gemme vare på serveren.', 'error', 2600);
      return;
    }

    const payload = getCatalogItemFromEditor();
    const validationError = validateCatalogItemPayload(payload);
    if (validationError) {
      showMessage(validationError, 'error');
      return;
    }

    try {
      if (state.itemEditorId) {
        await apiItemUpdate({ id: state.itemEditorId, ...payload });
        showMessage('Vare opdateret.', 'success', 1800);
      } else {
        await apiItemCreate(payload);
        showMessage('Vare oprettet.', 'success', 1800);
      }
      await refreshCatalogFromServer({ silent: true });
      resetItemEditor();
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke gemme vare: ${err.message || err}`, 'error', 3500);
      vibrateError();
    }
  }

  async function toggleCatalogItem(item) {
    if (!item) return;
    try {
      await apiItemToggle(item.id, !item.active);
      await refreshCatalogFromServer({ silent: true });
      showMessage(`Vare ${item.active ? 'deaktiveret' : 'aktiveret'}.`, 'success', 1800);
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke ændre varestatus: ${err.message || err}`, 'error', 3500);
    }
  }

  async function moveCatalogItem(item, direction) {
    if (!item) return;
    try {
      await apiItemMove(item.id, direction);
      await refreshCatalogFromServer({ silent: true });
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke flytte vare: ${err.message || err}`, 'error', 3500);
    }
  }

  async function deleteCatalogItem(item) {
    if (!item) return;
    const ok = confirm(`Slet varen "${item.name}" fra serveren?`);
    if (!ok) return;

    try {
      await apiItemDelete(item.id);
      await refreshCatalogFromServer({ silent: true });
      if (state.itemEditorId === item.id) resetItemEditor();
      showMessage('Vare slettet.', 'success', 1800);
      vibrateSuccess();
    } catch (err) {
      console.error(err);
      showMessage(`Kunne ikke slette vare: ${err.message || err}`, 'error', 3500);
      vibrateError();
    }
  }

  function renderSettingsItemsList() {
    if (!el.settingsItemsList) return;

    if (!hasApiConfig()) {
      el.settingsItemsList.innerHTML = '<div class="list-item muted">Sæt API base URL og API PIN først, så kan varer hentes fra serveren.</div>';
      return;
    }

    const items = getSortedCatalogItems();
    el.settingsItemsList.innerHTML = '';

    if (!items.length) {
      el.settingsItemsList.innerHTML = '<div class="list-item muted">Ingen varer på serveren endnu.</div>';
      return;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'list-item item-row';

      const meta = document.createElement('div');
      meta.className = 'item-row-meta';
      meta.innerHTML = `
        <div class="item-row-title">${escapeHtml(item.name)}</div>
        <div class="meta">${escapeHtml(item.buttonText || defaultCatalogButtonText(item))}</div>
        <div class="meta">${item.type === 'topup' ? 'Top-up' : 'Træk'} · ${escapeHtml(formatOre(item.amountOre))} · ${item.active ? 'Aktiv' : 'Inaktiv'}</div>
      `;

      const actions = document.createElement('div');
      actions.className = 'item-row-actions';

      const buttons = [
        { text: 'Redigér', cls: 'btn btn-secondary', onClick: () => fillItemEditor(item) },
        { text: item.active ? 'Slå fra' : 'Slå til', cls: 'btn btn-ghost', onClick: () => toggleCatalogItem(item) },
        { text: '↑', cls: 'btn btn-ghost', onClick: () => moveCatalogItem(item, 'up') },
        { text: '↓', cls: 'btn btn-ghost', onClick: () => moveCatalogItem(item, 'down') },
        { text: 'Slet', cls: 'btn btn-danger', onClick: () => deleteCatalogItem(item) }
      ];

      for (const cfg of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${cfg.cls} item-action-btn`;
        btn.textContent = cfg.text;
        btn.addEventListener('click', cfg.onClick);
        actions.appendChild(btn);
      }

      row.appendChild(meta);
      row.appendChild(actions);
      el.settingsItemsList.appendChild(row);
    }
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

    renderMemberActionButtons();

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

  async function exportServerBackupJson() {
    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
      return;
    }
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke hente backup fra serveren.', 'error', 2600);
      return;
    }

    try {
      showMessage('Henter fuld JSON-backup fra serveren…', 'warn', 0);
      const backup = await fetchServerBackupData({ includeTransactions: true });
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
      downloadBlob(blob, `sugekort-backup-${timestampForFilename()}.json`);
      showMessage(`JSON backup klar. ${backup.stats.cardCount} kort · ${backup.stats.transactionCount} transaktioner.`, 'success', 3500);
      showToast('Backup eksporteret ✅', 'success');
    } catch (err) {
      console.error(err);
      showMessage(`Eksportfejl (JSON): ${err.message || err}`, 'error', 4200);
      vibrateError();
    }
  }

  async function exportServerBackupCsv() {
    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
      return;
    }
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke hente CSV fra serveren.', 'error', 2600);
      return;
    }

    try {
      showMessage('Henter kortoversigt fra serveren…', 'warn', 0);
      const backup = await fetchServerBackupData({ includeTransactions: false });
      const csv = cardsToCsv(backup.cards || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `sugekort-kortoversigt-${timestampForFilename()}.csv`);
      showMessage(`CSV eksport klar. ${backup.stats.cardCount} kort.`, 'success', 3000);
      showToast('CSV eksporteret ✅', 'success');
    } catch (err) {
      console.error(err);
      showMessage(`Eksportfejl (CSV): ${err.message || err}`, 'error', 4200);
      vibrateError();
    }
  }

  async function onImportBackupJsonSelected(event) {
    const file = event?.target?.files?.[0];
    if (event?.target) event.target.value = '';
    if (!file) return;

    if (!hasApiConfig()) {
      showMessage('Mangler API base URL eller API PIN i indstillinger.', 'error');
      showScreen('screenSettings');
      return;
    }
    if (!navigator.onLine) {
      showMessage('Offline: kan ikke importere til serveren.', 'error', 2600);
      return;
    }

    try {
      const raw = await readFileAsText(file);
      const backup = parseBackupJson(raw);
      const stats = buildBackupStats(backup.cards, backup.transactions, backup.items);
      const ok = confirm(
        `ADVARSEL: Denne import OVERSKRIVER hele serverens data.

` +
        `Backup-fil: ${file.name}
` +
        `Varer i backup: ${stats.itemCount}
` +
        `Kort i backup: ${stats.cardCount}
` +
        `Transaktioner i backup: ${stats.transactionCount}

` +
        `Appen forsøger først at hente en sikkerhedskopi af serverens nuværende data, og derefter slettes serverens indhold før backupen indlæses.

` +
        `Fortsæt?`
      );
      if (!ok) return;

      let snapshotDownloaded = false;
      try {
        showMessage('Tager sikkerhedskopi af serverens nuværende data…', 'warn', 0);
        const snapshot = await fetchServerBackupData({ includeTransactions: true });
        const snapBlob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' });
        downloadBlob(snapBlob, `sugekort-server-snapshot-foer-import-${timestampForFilename()}.json`);
        snapshotDownloaded = true;
      } catch (snapshotErr) {
        console.warn('Kunne ikke hente server snapshot før import:', snapshotErr);
        const goOn = confirm(
          `Kunne ikke hente sikkerhedskopi af nuværende serverdata.

` +
          `Fejl: ${snapshotErr?.message || snapshotErr}

` +
          `Vil du fortsætte importen alligevel?`
        );
        if (!goOn) return;
      }

      const result = await overwriteServerFromBackup(backup);
      const snapshotMsg = snapshotDownloaded ? ' Der blev også hentet en sikkerhedskopi af den gamle serverdata.' : '';
      const warningMsg = result.warnings.length ? ` Advarsler: ${result.warnings.length}.` : '';
      showMessage(
        `Import gennemført. ${result.importedCards} kort gendannet.${snapshotMsg}${warningMsg}`,
        result.warnings.length ? 'warn' : 'success',
        6000
      );
      showToast('Import gennemført ✅', result.warnings.length ? 'warn' : 'success');
      if (result.warnings.length) {
        console.warn('Import warnings:', result.warnings);
      }
    } catch (err) {
      console.error(err);
      showMessage(`Importfejl: ${err.message || err}`, 'error', 5000);
      vibrateError();
    }
  }

  async function fetchServerBackupData({ includeTransactions = true } = {}) {
    const itemsResp = await apiItemsList();
    const items = normalizeCatalogItems(itemsResp);
    const searchResults = await fetchAllCardsFromServer();
    const cards = [];
    const transactions = [];

    for (let i = 0; i < searchResults.length; i++) {
      const cardId = extractCardId(searchResults[i]);
      if (!cardId) continue;

      showMessage(
        `Henter ${includeTransactions ? 'backup' : 'kortoversigt'} fra serveren… ${i + 1}/${searchResults.length}`,
        'warn',
        0
      );

      const resp = await apiCardGetById(cardId);
      if (!resp?.found || !resp.card) continue;

      const { card, balance } = splitServerCardGetPayload(resp.card);
      cards.push({
        cardId: card.cardId,
        memberName: card.memberName,
        status: card.status || 'active',
        createdAt: card.createdAt || null,
        updatedAt: card.updatedAt || null,
        balanceOre: Number(balance?.balanceOre || 0),
        balanceUpdatedAt: balance?.updatedAt || card.updatedAt || null
      });

      if (includeTransactions) {
        const historyResp = await apiCardHistory(cardId, 5000);
        const txs = normalizeTransactions(historyResp).map((tx) => ({
          timestamp: tx.timestamp || null,
          cardId: tx.cardId || card.cardId,
          type: tx.type || '',
          amountOre: Number(tx.amountOre || 0),
          balanceBeforeOre: Number(tx.balanceBeforeOre || 0),
          balanceAfterOre: Number(tx.balanceAfterOre || 0),
          operatorName: tx.operatorName || '',
          note: tx.note || ''
        }));
        transactions.push(...txs);
      }

      if ((i + 1) % 5 === 0) await nextUiFrame();
    }

    cards.sort((a, b) => String(a.memberName || a.cardId).localeCompare(String(b.memberName || b.cardId), 'da'));
    transactions.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));

    return {
      format: 'sugekort-server-backup-v2',
      exportedAt: new Date().toISOString(),
      appMode: 'server-only',
      clubName: state.settings.clubName || DEFAULT_SETTINGS.clubName,
      operatorName: state.settings.operatorName || DEFAULT_SETTINGS.operatorName,
      items,
      cards,
      transactions,
      stats: buildBackupStats(cards, transactions, items)
    };
  }

  async function fetchAllCardsFromServer() {
    const searchTerms = ['', ...'0123456789abcdefghijklmnopqrstuvwxyzæøåABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ'.split('')];
    const cardMap = new Map();
    let hadSuccessfulSearch = false;

    for (const term of searchTerms) {
      try {
        const resp = await apiCardSearch(term, 5000);
        hadSuccessfulSearch = true;
        const results = normalizeSearchResults(resp);
        for (const item of results) {
          const cardId = extractCardId(item);
          if (!cardId) continue;
          if (!cardMap.has(cardId)) cardMap.set(cardId, item);
        }

        if (term === '' && results.length) break;
      } catch (err) {
        if (term === '') {
          console.warn('Tom søgning understøttes ikke af API, bruger fallback-søgninger.', err);
        } else {
          console.warn(`Søgning fejlede for term "${term}":`, err);
        }
      }
    }

    if (!hadSuccessfulSearch) {
      throw new Error('Kunne ikke hente kort fra serveren. Tjek at /card/search virker.');
    }
    return [...cardMap.values()];
  }

  async function overwriteServerFromBackup(backup) {
    const warnings = [];
    const existingCards = await fetchAllCardsFromServer();

    for (let i = 0; i < existingCards.length; i++) {
      const cardId = extractCardId(existingCards[i]);
      if (!cardId) continue;
      showMessage(`Sletter eksisterende serverdata… ${i + 1}/${existingCards.length}`, 'warn', 0);
      await apiCardDelete(cardId);
      if ((i + 1) % 10 === 0) await nextUiFrame();
    }

    if (backup.hasItemsField) {
      const existingItems = normalizeCatalogItems(await apiItemsList());
      for (let i = 0; i < existingItems.length; i++) {
        showMessage(`Sletter eksisterende varer… ${i + 1}/${existingItems.length}`, 'warn', 0);
        await apiItemDelete(existingItems[i].id);
      }

      const sortedItems = getSortedCatalogItems(backup.items);
      for (let i = 0; i < sortedItems.length; i++) {
        const item = sortedItems[i];
        showMessage(`Importerer varer… ${i + 1}/${sortedItems.length}`, 'warn', 0);
        await apiItemCreate({
          name: item.name,
          amountOre: item.amountOre,
          type: item.type,
          buttonText: item.buttonText || defaultCatalogButtonText(item),
          style: item.style || (item.type === 'topup' ? 'success' : 'danger'),
          active: item.active,
          sortOrder: Number.isInteger(item.sortOrder) ? item.sortOrder : (i + 1)
        });
      }
    } else {
      warnings.push('Backup-filen mangler items[]. Eksisterende varer på serveren blev bevaret.');
    }

    const txByCard = new Map();
    for (const tx of backup.transactions || []) {
      const cardId = tx?.cardId;
      if (!cardId) continue;
      if (!txByCard.has(cardId)) txByCard.set(cardId, []);
      txByCard.get(cardId).push(tx);
    }
    for (const list of txByCard.values()) {
      list.sort((a, b) => String(a?.timestamp || '').localeCompare(String(b?.timestamp || '')));
    }

    let importedCards = 0;
    for (let i = 0; i < backup.cards.length; i++) {
      const card = backup.cards[i];
      if (!card?.cardId) {
        warnings.push('Et kort i backup mangler cardId og blev sprunget over.');
        continue;
      }

      showMessage(`Importerer kort… ${i + 1}/${backup.cards.length}`, 'warn', 0);
      await apiCardRegister({
        cardId: card.cardId,
        memberName: card.memberName || card.cardId,
        status: 'active'
      });

      const txs = txByCard.get(card.cardId) || [];
      if (txs.length) {
        for (let txIndex = 0; txIndex < txs.length; txIndex++) {
          const tx = txs[txIndex];
          const mode = mapImportTxMode(tx);
          const amountOre = Math.abs(Number(tx?.amountOre || 0));
          if (!mode || !(amountOre > 0)) continue;

          const noteParts = ['Import backup'];
          if (tx?.note) noteParts.push(String(tx.note));
          if (tx?.timestamp) noteParts.push(String(tx.timestamp));
          const note = noteParts.join(' | ').slice(0, 250);
          const basePayload = {
            cardId: card.cardId,
            amountOre,
            note,
            operatorName: tx?.operatorName || 'Backup import',
            clientTxId: `import-${sanitizeFilename(card.cardId)}-${i}-${txIndex}-${Date.now()}`
          };

          if (mode === 'topup') {
            await apiTxTopup(basePayload);
          } else {
            await apiTxPurchase(basePayload);
          }
        }
      } else {
        const balanceOre = Number(card.balanceOre || 0);
        if (balanceOre > 0) {
          await apiTxTopup({
            cardId: card.cardId,
            amountOre: balanceOre,
            note: 'Import backup startsaldo',
            operatorName: 'Backup import',
            clientTxId: `import-balance-${sanitizeFilename(card.cardId)}-${Date.now()}`
          });
        } else if (balanceOre < 0) {
          warnings.push(`Kort ${card.cardId} havde negativ saldo i backup og kunne ikke genskabes præcist.`);
        }
      }

      if (String(card.status || '').toLowerCase() === 'blocked') {
        await apiCardSetStatus(card.cardId, 'blocked');
      }

      importedCards += 1;
      if ((i + 1) % 3 === 0) await nextUiFrame();
    }

    await refreshCatalogFromServer({ silent: true });
    return { importedCards, warnings };
  }

  function buildBackupStats(cards = [], transactions = [], items = []) {
    return {
      itemCount: Array.isArray(items) ? items.length : 0,
      cardCount: Array.isArray(cards) ? cards.length : 0,
      transactionCount: Array.isArray(transactions) ? transactions.length : 0
    };
  }

  function parseBackupJson(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error('JSON-filen kunne ikke læses.');
    }

    const cards = Array.isArray(data?.cards) ? data.cards : [];
    const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
    const hasItemsField = Array.isArray(data?.items);
    const items = hasItemsField ? data.items : [];
    if (!Array.isArray(data?.cards)) {
      throw new Error('Backup-filen mangler feltet cards[].');
    }

    return {
      format: data?.format || 'ukendt',
      exportedAt: data?.exportedAt || null,
      hasItemsField,
      items: normalizeCatalogItems(items),
      cards: cards.map((card) => ({
        cardId: String(card?.cardId || '').trim(),
        memberName: String(card?.memberName || card?.cardId || '').trim(),
        status: String(card?.status || 'active').trim() || 'active',
        createdAt: card?.createdAt || null,
        updatedAt: card?.updatedAt || null,
        balanceOre: Number(card?.balanceOre || 0),
        balanceUpdatedAt: card?.balanceUpdatedAt || null
      })),
      transactions: transactions.map((tx) => ({
        timestamp: tx?.timestamp || null,
        cardId: String(tx?.cardId || '').trim(),
        type: String(tx?.type || '').trim(),
        amountOre: Number(tx?.amountOre || 0),
        balanceBeforeOre: Number(tx?.balanceBeforeOre || 0),
        balanceAfterOre: Number(tx?.balanceAfterOre || 0),
        operatorName: String(tx?.operatorName || '').trim(),
        note: String(tx?.note || '').trim()
      })).filter((tx) => tx.cardId)
    };
  }

  function normalizeSearchResults(resp) {
    return Array.isArray(resp?.cards) ? resp.cards
      : Array.isArray(resp?.results) ? resp.results
      : Array.isArray(resp) ? resp
      : [];
  }

  function normalizeTransactions(resp) {
    return Array.isArray(resp?.transactions) ? resp.transactions
      : Array.isArray(resp?.history) ? resp.history
      : Array.isArray(resp) ? resp
      : [];
  }

  function extractCardId(item) {
    return String(item?.cardId || item?.card_id || '').trim();
  }

  function mapImportTxMode(tx) {
    const type = String(tx?.type || '').toLowerCase();
    if (type === 'purchase') return 'purchase';
    if (type === 'topup' || type === 'refund') return 'topup';
    if (type === 'adjustment') return Number(tx?.amountOre || 0) < 0 ? 'purchase' : 'topup';
    if (Number(tx?.amountOre || 0) < 0) return 'purchase';
    if (Number(tx?.amountOre || 0) > 0) return 'topup';
    return null;
  }

  function cardsToCsv(cards) {
    const header = [
      'memberName', 'cardId', 'status', 'balanceOre', 'balanceKr', 'createdAt', 'updatedAt', 'balanceUpdatedAt'
    ];
    const lines = [header.join(';')];
    for (const card of cards) {
      const vals = [
        card.memberName || '',
        card.cardId || '',
        card.status || 'active',
        Number(card.balanceOre || 0),
        oreToCsvKr(card.balanceOre || 0),
        card.createdAt || '',
        card.updatedAt || '',
        card.balanceUpdatedAt || ''
      ].map(csvEscape);
      lines.push(vals.join(';'));
    }
    return lines.join('\n');
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

  async function runStartupApiCheck() {
    try {
      if (!hasApiConfig()) {
        setScanState('API ikke sat op', 'Udfyld API base URL og API PIN under Indstillinger før du scanner.', 'warn');
        showMessage('API ikke testet ved opstart: mangler API base URL eller API PIN.', 'warn', 4200);
        return;
      }

      if (!navigator.onLine) {
        setScanState('Offline ved opstart', 'Telefonen er offline, så API-forbindelsen kunne ikke testes.', 'error');
        showMessage('API ikke testet ved opstart: telefonen er offline.', 'error', 4200);
        return;
      }

      const health = await apiGetHealth();
      const dbText = health?.db ? ` DB: ${health.db}` : '';
      setScanState('API forbindelse OK', `Serveren svarer korrekt.${dbText} Du kan scanne kort nu.`, 'success');
      showMessage(`API forbindelse OK ✅${dbText}`, 'success', 2600);
      showToast('API forbindelse virker', 'success');
    } catch (err) {
      console.error('Startup API check failed:', err);
      const errText = err?.message || String(err);
      setScanState('API forbindelse fejlede', `Kunne ikke kontakte serveren: ${errText}`, 'error');
      showMessage(`API forbindelse fejlede ved opstart: ${errText}`, 'error', 4500);
      vibrateError();
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

  async function apiItemsList() {
    return await apiPost('/items/list', {});
  }

  async function apiItemCreate(payload) {
    return await apiPost('/items/create', payload);
  }

  async function apiItemUpdate(payload) {
    return await apiPost('/items/update', payload);
  }

  async function apiItemDelete(id) {
    return await apiPost('/items/delete', { id });
  }

  async function apiItemToggle(id, active) {
    return await apiPost('/items/toggle', { id, active });
  }

  async function apiItemMove(id, direction) {
    return await apiPost('/items/move', { id, direction });
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

  async function readFileAsText(file) {
    return await file.text();
  }

  async function nextUiFrame() {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
