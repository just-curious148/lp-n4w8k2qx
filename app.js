(function () {
  "use strict";

  const KEY = "laundry-pay-v1";
  const DAD_RATE = 2;
  const FAMILY_RATE = 1;
  const HISTORY_MAX = 40;
  const UNDO_WINDOW_MS = 2 * 60 * 1000;

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

  function emptyState() {
    return { dadUnpaid: 0, otherUnpaid: 0, credit: 0, history: [], ledger: [] };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      const data = JSON.parse(raw);
      return {
        dadUnpaid: Math.max(0, Number(data.dadUnpaid) || 0),
        otherUnpaid: Math.max(0, Number(data.otherUnpaid) || 0),
        credit: Math.max(0, Number(data.credit) || 0),
        history: Array.isArray(data.history) ? data.history : [],
        ledger: Array.isArray(data.ledger) ? data.ledger : seedLedger(data.history),
      };
    } catch (e) {
      return emptyState();
    }
  }

  /**
   * Ledger is the uncapped record the earnings report reads
   * (history is trimmed to the last 40 items for display).
   * Entries: { t: "load"|"pay", kind?: "dad"|"family", amt, at }.
   */
  function seedLedger(history) {
    if (!Array.isArray(history)) return [];
    const out = [];
    history.slice().reverse().forEach(function (h) {
      if (h.type === "add-dad") out.push({ t: "load", kind: "dad", amt: DAD_RATE, at: h.at });
      else if (h.type === "add-family") out.push({ t: "load", kind: "family", amt: FAMILY_RATE, at: h.at });
      else if ((h.type === "pay" || h.type === "pay-full") && Number(h.amount) > 0)
        out.push({ t: "pay", amt: Number(h.amount), at: h.at });
    });
    return out;
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function owed(state) {
    return DAD_RATE * state.dadUnpaid + FAMILY_RATE * state.otherUnpaid;
  }

  /** Loads owed minus any overpayment credit. Negative means Baba overpaid. */
  function balance(state) {
    return owed(state) - (state.credit || 0);
  }

  function money(n) {
    n = Number(n);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
  }

  function nowIso() {
    return new Date().toISOString();
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

  function pushHistory(state, item) {
    state.history.unshift(item);
    if (state.history.length > HISTORY_MAX) {
      state.history.length = HISTORY_MAX;
    }
  }

  function lastIsAdd(state) {
    const last = state.history[0];
    return last && (last.type === "add-dad" || last.type === "add-family");
  }

  function lastAddAgeMs(state) {
    if (!lastIsAdd(state)) return Infinity;
    const at = Date.parse(state.history[0].at);
    if (!Number.isFinite(at)) return Infinity;
    return Date.now() - at;
  }

  function lastAddIsUndoable(state) {
    return lastIsAdd(state) && lastAddAgeMs(state) < UNDO_WINDOW_MS;
  }

  let state = load();
  let undoLockTimer = null;

  function scheduleUndoLock() {
    if (undoLockTimer) {
      clearTimeout(undoLockTimer);
      undoLockTimer = null;
    }
    if (!lastAddIsUndoable(state)) return;
    const remaining = UNDO_WINDOW_MS - lastAddAgeMs(state);
    if (remaining <= 0) return;
    undoLockTimer = setTimeout(function () {
      undoLockTimer = null;
      render();
    }, remaining);
  }

  function render() {
    const total = balance(state);
    els.owedAmount.textContent = money(total);
    els.dadCount.textContent = String(state.dadUnpaid);
    els.familyCount.textContent = String(state.otherUnpaid);
    els.undoBtn.disabled = !lastAddIsUndoable(state);
    els.payBtn.disabled = false;
    els.paySheetOwed.textContent = "Baba owes " + money(total);
    els.payFullBtn.textContent = "Paid in full " + money(total);

    if (!lastAddIsUndoable(state)) closeUndoConfirm();
    scheduleUndoLock();

    if (!state.history.length) {
      els.historyList.innerHTML = '<li><span class="empty">No loads yet. Tap a button!</span></li>';
      return;
    }

    els.historyList.innerHTML = state.history
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

  function commit() {
    save(state);
    render();
    fillYearOptions();
    renderReport();
  }

  function addLoad(kind) {
    const rate = kind === "dad" ? DAD_RATE : FAMILY_RATE;
    // An overpayment credit covers new loads first.
    const fromCredit = (state.credit || 0) >= rate;
    if (fromCredit) state.credit -= rate;
    else if (kind === "dad") state.dadUnpaid += 1;
    else state.otherUnpaid += 1;
    pushHistory(state, {
      type: kind === "dad" ? "add-dad" : "add-family",
      label: (kind === "dad" ? "Baba's load +$2" : "Family load +$1") + (fromCredit ? " (from extra paid)" : ""),
      at: nowIso(),
      fromCredit: fromCredit,
    });
    state.ledger.push({ t: "load", kind: kind, amt: rate, at: nowIso() });
    commit();
  }

  function undoLastAdd() {
    if (!lastAddIsUndoable(state)) return;
    const last = state.history[0];
    if (last.fromCredit) {
      state.credit = (state.credit || 0) + (last.type === "add-dad" ? DAD_RATE : FAMILY_RATE);
    } else if (last.type === "add-dad") {
      if (state.dadUnpaid < 1) return;
      state.dadUnpaid -= 1;
    } else {
      if (state.otherUnpaid < 1) return;
      state.otherUnpaid -= 1;
    }
    state.history.shift();
    for (let i = state.ledger.length - 1; i >= 0; i--) {
      if (state.ledger[i].t === "load") { state.ledger.splice(i, 1); break; }
    }
    commit();
  }

  /**
   * Pay dad loads first ($2), then family ($1).
   * Integer loads only so owed always equals 2*dad + 1*family.
   * Leftover $1 with only dad loads remaining cannot apply (would break a $2 load).
   */
  function applyPayment(requested) {
    const total = owed(state);
    let remaining = Math.min(Math.max(0, Math.floor(requested)), total);
    const start = remaining;
    if (remaining <= 0) return { applied: 0, leftover: 0, dadLoads: 0, familyLoads: 0 };

    let dadLoads = 0;
    let familyLoads = 0;

    while (remaining >= DAD_RATE && state.dadUnpaid > 0) {
      state.dadUnpaid -= 1;
      remaining -= DAD_RATE;
      dadLoads += 1;
    }
    while (remaining >= FAMILY_RATE && state.otherUnpaid > 0) {
      state.otherUnpaid -= 1;
      remaining -= FAMILY_RATE;
      familyLoads += 1;
    }

    return {
      applied: start - remaining,
      leftover: remaining,
      dadLoads: dadLoads,
      familyLoads: familyLoads,
    };
  }

  function payPartial(raw) {
    hideHint();
    const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
    if (!n || n < 1) {
      showHint("Type a whole-dollar amount.");
      return;
    }

    const result = applyPayment(n);
    // Anything not used on a whole load is kept as credit, so overpaying
    // shows a negative balance (owes $10, pays $12, balance -$2).
    const extra = n - result.applied;
    state.credit = (state.credit || 0) + extra;

    let label = "Baba paid " + money(n);
    if (balance(state) < 0) label += " (extra " + money(-balance(state)) + ")";

    pushHistory(state, {
      type: "pay",
      label: label,
      at: nowIso(),
      amount: n,
    });
    state.ledger.push({ t: "pay", amt: n, at: nowIso() });
    commit();
    closePay();
  }

  function payInFull() {
    const total = balance(state);
    if (total <= 0) {
      closeConfirm();
      closePay();
      return;
    }
    state.dadUnpaid = 0;
    state.otherUnpaid = 0;
    state.credit = 0;
    pushHistory(state, {
      type: "pay-full",
      label: "Baba paid in full " + money(total),
      at: nowIso(),
      amount: total,
    });
    state.ledger.push({ t: "pay", amt: total, at: nowIso() });
    commit();
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
    const total = balance(state);
    els.confirmCopy.textContent =
      "This zeros every unpaid load. Baba paid " + money(total) + ".";
    els.confirmOverlay.classList.remove("hidden");
  }

  function closeConfirm() {
    els.confirmOverlay.classList.add("hidden");
  }

  function openUndoConfirm() {
    if (!lastAddIsUndoable(state)) return;
    els.undoOverlay.classList.remove("hidden");
  }

  function closeUndoConfirm() {
    els.undoOverlay.classList.add("hidden");
  }

  els.addDad.addEventListener("click", function () { addLoad("dad"); });
  els.addFamily.addEventListener("click", function () { addLoad("family"); });
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
    undoLastAdd();
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

  /* ---------- Earnings report ---------- */
  function periodRange(key) {
    const now = new Date();
    const y = now.getFullYear();
    if (key === "week") {
      const start = new Date(y, now.getMonth(), now.getDate() - now.getDay()); // Sunday
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
    state.ledger.forEach(function (e) {
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
    state.ledger.forEach(function (e) {
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

  render();
  fillYearOptions();
  renderReport();
})();
