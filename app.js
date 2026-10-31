(function () {
  "use strict";

  const R = globalThis.LaundryReducer;
  const money = R.money;
  const API_BASE = "https://laundry-pay-sync.enchanted-haumea.workers.dev";
  const KEY = "laundry-pay-v2";
  const LEGACY_KEY = "laundry-pay-v1";
  const SECRET_KEY = "laundry-pay-secret";
  const SECRET = /^[A-Za-z0-9_-]{8,256}$/;
  const HISTORY_SHOWN = 40;

  const $ = (id) => document.getElementById(id);

  const els = {
    owedAmount: $("owedAmount"),
    dadCount: $("dadCount"),
    familyCount: $("familyCount"),
    addDad: $("addDad"),
    addFamily: $("addFamily"),
    undoBtn: $("undoBtn"),
    payBtn: $("payBtn"),
    historyList: $("historyList"),
    payOverlay: $("payOverlay"),
    confirmOverlay: $("confirmOverlay"),
    undoOverlay: $("undoOverlay"),
    paySheetOwed: $("paySheetOwed"),
    payFullBtn: $("payFullBtn"),
    payAmount: $("payAmount"),
    payPartialBtn: $("payPartialBtn"),
    payCancel: $("payCancel"),
    payHint: $("payHint"),
    confirmCopy: $("confirmCopy"),
    confirmYes: $("confirmYes"),
    confirmNo: $("confirmNo"),
    undoYes: $("undoYes"),
    undoNo: $("undoNo"),
    reportPeriod: $("reportPeriod"),
    reportTitle: $("reportTitle"),
    reportEarned: $("reportEarned"),
    reportReceived: $("reportReceived"),
    reportLoads: $("reportLoads"),
    reportPayments: $("reportPayments"),
    reportDiff: $("reportDiff"),
    reportCopy: $("reportCopy"),
  };

  function loadStore() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY));
      return {
        events: Array.isArray(data.events) ? data.events : [],
        outbox: Array.isArray(data.outbox) ? data.outbox : [],
        migrated: data.migrated === true,
      };
    } catch (e) {
      return { events: [], outbox: [], migrated: false };
    }
  }

  function secret() {
    return localStorage.getItem(SECRET_KEY);
  }

  function knownIds() {
    return new Set(store.events.concat(store.outbox).map(function (event) { return event.id; }));
  }

  function persist() {
    const known = knownIds();
    store.migrated = Boolean(secret()) && legacyIds.every(function (id) { return known.has(id); });
    localStorage.setItem(KEY, JSON.stringify(store));
  }

  function adoptSecretFromHash() {
    const k = new URLSearchParams(location.hash.slice(1)).get("k");
    if (k === null) return;
    if (SECRET.test(k) && k !== secret()) {
      localStorage.setItem(SECRET_KEY, k);
      store.events = [];
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  // Re-read on every boot. An app.js still cached by an old service worker in
  // another tab can write v1 after this device has migrated.
  function queueLegacy() {
    const legacy = R.migrationEvents(localStorage.getItem(LEGACY_KEY));
    const known = knownIds();
    legacy.forEach(function (event) {
      if (known.has(event.id)) return;
      known.add(event.id);
      store.outbox.push(event);
    });
    return legacy.map(function (event) { return event.id; });
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function undoable() {
    return view.undo !== null && Date.now() < Date.parse(view.undo.expiresAt);
  }

  let view = null;
  let undoLockTimer = null;

  function scheduleUndoLock() {
    if (undoLockTimer) {
      clearTimeout(undoLockTimer);
      undoLockTimer = null;
    }
    if (!undoable()) return;
    undoLockTimer = setTimeout(function () {
      undoLockTimer = null;
      render();
    }, Date.parse(view.undo.expiresAt) - Date.now());
  }

  function render() {
    const total = view.balance;
    els.owedAmount.textContent = money(total);
    els.dadCount.textContent = String(view.dadUnpaid);
    els.familyCount.textContent = String(view.otherUnpaid);
    els.undoBtn.disabled = !undoable();
    els.payBtn.disabled = false;
    els.paySheetOwed.textContent = "Baba owes " + money(total);
    els.payFullBtn.textContent = "Paid in full " + money(total);

    if (!undoable()) closeUndoConfirm();
    scheduleUndoLock();

    const shown = view.history.slice(0, HISTORY_SHOWN);
    if (!shown.length) {
      els.historyList.innerHTML = '<li><span class="empty">No loads yet. Tap a button!</span></li>';
      return;
    }

    els.historyList.innerHTML = shown
      .map(function (item) {
        var cls = "dad-item";
        var label = item.label;
        if (item.type === "add-family") cls = "family-item";
        if (item.type === "pay" || item.type === "pay-full") cls = "pay-item";
        return (
          "<li class=\"" +
          cls +
          "\"><span>" +
          escapeHtml(label) +
          '</span><span class="when">' +
          escapeHtml(formatWhen(item.at)) +
          "</span></li>"
        );
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function refresh() {
    view = R.project(store.events.concat(store.outbox));
    render();
    fillYearOptions();
    renderReport();
  }

  function record(intent) {
    const result = R.tap(store.events.concat(store.outbox), intent, crypto.randomUUID(), Date.now());
    if (result.status !== "appended") return;
    store.outbox.push(result.event);
    persist();
    refresh();
    flush();
  }

  async function fetchJson(url, init) {
    try {
      const res = await fetch(url, init);
      return { status: res.status, body: await res.json() };
    } catch (e) {
      return null;
    }
  }

  async function sync() {
    const key = secret();
    if (!key) return;
    const api = API_BASE + "/s/" + encodeURIComponent(key) + "/api";

    while (store.outbox.length) {
      const head = store.outbox[0];
      const res = await fetchJson(api + "/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(head),
      });
      if (!res) return;
      if (res.status === 200 || res.status === 201) {
        if (!res.body.event || res.body.event.id !== head.id) return;
        store.events.push(res.body.event);
      } else if (res.status !== 400 && res.status !== 409) {
        return;
      }
      store.outbox = store.outbox.filter(function (event) { return event.id !== head.id; });
      persist();
      refresh();
    }

    const res = await fetchJson(api + "/state");
    if (!res || res.status !== 200 || !Array.isArray(res.body.events)) return;
    store.events = res.body.events;
    const onServer = new Set(store.events.map(function (event) { return event.id; }));
    store.outbox = store.outbox.filter(function (event) { return !onServer.has(event.id); });
    persist();
    refresh();
  }

  let flushing = false;
  let flushAgain = false;

  async function flush() {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushAgain = false;
        await sync();
      } while (flushAgain);
    } finally {
      flushing = false;
    }
  }

  function payPartial(raw) {
    hideHint();
    const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
    if (!n || n < 1) {
      showHint("Type a whole-dollar amount.");
      return;
    }
    record({ type: "baba_paid", amount: n });
    closePay();
  }

  function payInFull() {
    record({ type: "baba_paid_in_full" });
    closeConfirm();
    closePay();
  }

  function showHint(msg) {
    els.payHint.textContent = msg;
    els.payHint.classList.remove("hidden");
  }

  function hideHint() {
    els.payHint.textContent = "";
    els.payHint.classList.add("hidden");
  }

  function openPay() {
    hideHint();
    els.payAmount.value = "";
    els.payOverlay.classList.remove("hidden");
    render();
  }

  function closePay() {
    els.payOverlay.classList.add("hidden");
    hideHint();
  }

  function openConfirm() {
    const total = view.balance;
    els.confirmCopy.textContent =
      "This zeros every unpaid load. Baba paid " + money(total) + ".";
    els.confirmOverlay.classList.remove("hidden");
  }

  function closeConfirm() {
    els.confirmOverlay.classList.add("hidden");
  }

  function openUndoConfirm() {
    if (!undoable()) return;
    els.undoOverlay.classList.remove("hidden");
  }

  function closeUndoConfirm() {
    els.undoOverlay.classList.add("hidden");
  }

  els.addDad.addEventListener("click", function () { record({ type: "baba_load" }); });
  els.addFamily.addEventListener("click", function () { record({ type: "family_load" }); });
  els.undoBtn.addEventListener("click", openUndoConfirm);
  els.payBtn.addEventListener("click", openPay);
  els.payCancel.addEventListener("click", closePay);
  els.payFullBtn.addEventListener("click", openConfirm);
  els.payPartialBtn.addEventListener("click", function () {
    payPartial(els.payAmount.value);
  });
  els.payAmount.addEventListener("input", function () {
    els.payAmount.value = els.payAmount.value.replace(/[^0-9]/g, "");
  });
  els.payAmount.addEventListener("keydown", function (e) {
    if (e.key === "Enter") payPartial(els.payAmount.value);
  });
  els.confirmYes.addEventListener("click", payInFull);
  els.confirmNo.addEventListener("click", closeConfirm);
  els.undoYes.addEventListener("click", function () {
    record({ type: "undo" });
    closeUndoConfirm();
  });
  els.undoNo.addEventListener("click", closeUndoConfirm);

  els.payOverlay.addEventListener("click", function (e) {
    if (e.target === els.payOverlay) closePay();
  });
  els.confirmOverlay.addEventListener("click", function (e) {
    if (e.target === els.confirmOverlay) closeConfirm();
  });
  els.undoOverlay.addEventListener("click", function (e) {
    if (e.target === els.undoOverlay) closeUndoConfirm();
  });

  function periodRange(key) {
    const now = new Date();
    const y = now.getFullYear();
    if (key === "week") {
      const daysSinceSunday = now.getDay();
      const start = new Date(y, now.getMonth(), now.getDate() - daysSinceSunday);
      return { start: start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7), label: "This week (since Sunday)" };
    }
    if (key === "month") {
      return { start: new Date(y, now.getMonth(), 1), end: new Date(y, now.getMonth() + 1, 1),
        label: now.toLocaleString(undefined, { month: "long", year: "numeric" }) };
    }
    if (key === "ytd") {
      return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), label: y + " year to date" };
    }
    const yr = parseInt(key, 10);
    return { start: new Date(yr, 0, 1), end: new Date(yr + 1, 0, 1), label: "Calendar year " + yr };
  }

  function buildReport(key) {
    const r = periodRange(key);
    const rep = { label: r.label, earned: 0, received: 0, dadLoads: 0, familyLoads: 0, payments: 0 };
    view.ledger.forEach(function (e) {
      const t = Date.parse(e.at);
      if (!(t >= r.start.getTime() && t < r.end.getTime())) return;
      if (e.t === "load") {
        rep.earned += e.amt;
        if (e.kind === "dad") rep.dadLoads += 1; else rep.familyLoads += 1;
      } else if (e.t === "pay") {
        rep.received += e.amt;
        rep.payments += 1;
      }
    });
    return rep;
  }

  function fillYearOptions() {
    const sel = els.reportPeriod;
    if (!sel) return;
    const years = {};
    years[new Date().getFullYear()] = true;
    view.ledger.forEach(function (e) {
      const d = new Date(e.at);
      if (!isNaN(d)) years[d.getFullYear()] = true;
    });
    const current = sel.value;
    Array.prototype.slice.call(sel.querySelectorAll("option[data-year]")).forEach(function (o) { o.remove(); });
    Object.keys(years).sort().reverse().forEach(function (yr) {
      const o = document.createElement("option");
      o.value = yr;
      o.textContent = "Year " + yr;
      o.setAttribute("data-year", "1");
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function renderReport() {
    if (!els.reportPeriod) return;
    const rep = buildReport(els.reportPeriod.value || "week");
    els.reportTitle.textContent = rep.label;
    els.reportEarned.textContent = money(rep.earned);
    els.reportReceived.textContent = money(rep.received);
    els.reportLoads.textContent =
      rep.dadLoads + " Baba load" + (rep.dadLoads === 1 ? "" : "s") + ", " +
      rep.familyLoads + " family load" + (rep.familyLoads === 1 ? "" : "s");
    els.reportPayments.textContent = rep.payments + " payment" + (rep.payments === 1 ? "" : "s");
    els.reportDiff.textContent = money(rep.earned - rep.received);
  }

  if (els.reportPeriod) {
    els.reportPeriod.addEventListener("change", renderReport);
    els.reportCopy.addEventListener("click", function () {
      const rep = buildReport(els.reportPeriod.value || "week");
      const text = "Laundry Pay earnings: " + rep.label + "\n" +
        "Earned from loads: " + money(rep.earned) + " (" + els.reportLoads.textContent + ")\n" +
        "Paid by Baba: " + money(rep.received) + " (" + els.reportPayments.textContent + ")\n" +
        "Earned minus paid: " + money(rep.earned - rep.received);
      const done = function () { els.reportCopy.textContent = "Copied"; setTimeout(function () { els.reportCopy.textContent = "Copy report"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }

  const store = loadStore();
  adoptSecretFromHash();
  const legacyIds = queueLegacy();
  persist();
  refresh();
  flush();

  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") flush();
  });
})();
