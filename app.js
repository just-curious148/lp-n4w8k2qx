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
  };

  function emptyState() {
    return { dadUnpaid: 0, otherUnpaid: 0, history: [] };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      const data = JSON.parse(raw);
      return {
        dadUnpaid: Math.max(0, Number(data.dadUnpaid) || 0),
        otherUnpaid: Math.max(0, Number(data.otherUnpaid) || 0),
        history: Array.isArray(data.history) ? data.history : [],
      };
    } catch (e) {
      return emptyState();
    }
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function owed(state) {
    return DAD_RATE * state.dadUnpaid + FAMILY_RATE * state.otherUnpaid;
  }

  function money(n) {
    return "$" + Number(n).toFixed(2);
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
    const total = owed(state);
    els.owedAmount.textContent = money(total);
    els.dadCount.textContent = String(state.dadUnpaid);
    els.familyCount.textContent = String(state.otherUnpaid);
    els.undoBtn.disabled = !lastAddIsUndoable(state);
    els.payBtn.disabled = total <= 0;
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
  }

  function addLoad(kind) {
    if (kind === "dad") {
      state.dadUnpaid += 1;
      pushHistory(state, {
        type: "add-dad",
        label: "Baba's load +$2",
        at: nowIso(),
      });
    } else {
      state.otherUnpaid += 1;
      pushHistory(state, {
        type: "add-family",
        label: "Family load +$1",
        at: nowIso(),
      });
    }
    commit();
  }

  function undoLastAdd() {
    if (!lastAddIsUndoable(state)) return;
    const last = state.history[0];
    if (last.type === "add-dad") {
      if (state.dadUnpaid < 1) return;
      state.dadUnpaid -= 1;
    } else {
      if (state.otherUnpaid < 1) return;
      state.otherUnpaid -= 1;
    }
    state.history.shift();
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

    const before = owed(state);
    if (before <= 0) {
      showHint("Baba doesn't owe anything right now.");
      return;
    }

    const capped = Math.min(n, before);
    const result = applyPayment(capped);

    if (result.applied <= 0) {
      showHint("Need at least $2 to pay a Baba load (or add a $1 family load).");
      return;
    }

    let label = "Baba paid " + money(result.applied);
    if (n > before) label += " (capped)";
    else if (result.leftover > 0) label += " (kept leftover $1)";

    pushHistory(state, {
      type: "pay",
      label: label,
      at: nowIso(),
      amount: result.applied,
    });
    commit();
    closePay();
  }

  function payInFull() {
    const total = owed(state);
    if (total <= 0) {
      closeConfirm();
      closePay();
      return;
    }
    state.dadUnpaid = 0;
    state.otherUnpaid = 0;
    pushHistory(state, {
      type: "pay-full",
      label: "Baba paid in full " + money(total),
      at: nowIso(),
      amount: total,
    });
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
    if (owed(state) <= 0) return;
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
    const total = owed(state);
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }

  render();
})();
