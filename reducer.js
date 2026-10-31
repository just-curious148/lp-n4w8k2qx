(function () {
  "use strict";

  const DAD_RATE = 2;
  const FAMILY_RATE = 1;
  const UNDO_WINDOW_MS = 2 * 60 * 1000;
  const MAX_AHEAD_MS = 60 * 60 * 1000;
  const MAX_AMOUNT = 100000;
  const MAX_NOTE = 200;
  const UNDO_PREFIX = "undo:";
  const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const ID = /^[A-Za-z0-9._:-]{1,128}$/;
  const FIELDS = ["id", "type", "amount", "note", "at"];

  const LOADS = {
    baba_load: { rate: DAD_RATE, chip: "dadUnpaid", kind: "dad", type: "add-dad", label: "Baba's load +$2" },
    family_load: { rate: FAMILY_RATE, chip: "otherUnpaid", kind: "family", type: "add-family", label: "Family load +$1" },
  };

  const FOLD = new Map([
    ["baba_load", foldLoad],
    ["family_load", foldLoad],
    ["baba_paid", foldPaid],
    ["baba_paid_in_full", foldPaidInFull],
    ["undo", foldUndo],
  ]);

  const PAID = new Set(["baba_paid", "baba_paid_in_full"]);

  const LEGACY = new Map([
    ["add-dad", "baba_load"],
    ["add-family", "family_load"],
    ["pay", "baba_paid"],
    ["pay-full", "baba_paid_in_full"],
  ]);

  function money(n) {
    return (n < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2);
  }

  function owed(book) {
    return DAD_RATE * book.dadUnpaid + FAMILY_RATE * book.otherUnpaid;
  }

  function balanceOf(book) {
    return owed(book) - book.credit;
  }

  function foldLoad(book, event) {
    const load = LOADS[event.type];
    const fromCredit = book.credit >= load.rate;
    if (fromCredit) book.credit -= load.rate;
    else book[load.chip] += 1;
    book.rows.push({
      load: load,
      history: {
        id: event.id,
        type: load.type,
        label: load.label + (fromCredit ? " (from extra paid)" : ""),
        at: event.at,
        fromCredit: fromCredit,
      },
      ledger: { t: "load", kind: load.kind, amt: load.rate, at: event.at },
    });
  }

  function foldPaid(book, event) {
    const usable = Math.min(event.amount, owed(book));
    const dad = Math.min(book.dadUnpaid, Math.floor(usable / DAD_RATE));
    const family = Math.min(book.otherUnpaid, Math.floor((usable - DAD_RATE * dad) / FAMILY_RATE));
    book.dadUnpaid -= dad;
    book.otherUnpaid -= family;
    book.credit += event.amount - DAD_RATE * dad - FAMILY_RATE * family;
    const after = balanceOf(book);
    pushPay(book, event, "pay", "Baba paid " + money(event.amount) + (after < 0 ? " (extra " + money(-after) + ")" : ""));
  }

  function foldPaidInFull(book, event) {
    if (balanceOf(book) <= 0) return;
    book.dadUnpaid = 0;
    book.otherUnpaid = 0;
    book.credit = 0;
    pushPay(book, event, "pay-full", "Baba paid in full " + money(event.amount));
  }

  function pushPay(book, event, type, label) {
    book.rows.push({
      load: null,
      history: { id: event.id, type: type, label: label, at: event.at, amount: event.amount },
      ledger: { t: "pay", amt: event.amount, at: event.at },
    });
  }

  function foldUndo(book, event) {
    const head = book.rows[book.rows.length - 1];
    if (!head || !head.load || UNDO_PREFIX + head.history.id !== event.id) return;
    const age = Date.parse(event.at) - Date.parse(head.history.at);
    if (age < 0 || age >= UNDO_WINDOW_MS) return;
    if (head.history.fromCredit) book.credit += head.load.rate;
    else book[head.load.chip] -= 1;
    book.rows.pop();
  }

  function byAtThenId(a, b) {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  }

  function project(events) {
    const seen = new Set();
    const log = events.filter(function (event) {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
    log.sort(byAtThenId);

    const book = { dadUnpaid: 0, otherUnpaid: 0, credit: 0, rows: [] };
    log.forEach(function (event) {
      const fold = FOLD.get(event.type);
      if (fold) fold(book, event);
    });

    const head = book.rows[book.rows.length - 1];
    return {
      balance: balanceOf(book),
      dadUnpaid: book.dadUnpaid,
      otherUnpaid: book.otherUnpaid,
      credit: book.credit,
      undo: head && head.load
        ? {
            id: UNDO_PREFIX + head.history.id,
            expiresAt: new Date(Date.parse(head.history.at) + UNDO_WINDOW_MS).toISOString(),
          }
        : null,
      history: book.rows.map(function (row) { return row.history; }).reverse(),
      ledger: book.rows.map(function (row) { return row.ledger; }),
    };
  }

  function isIsoAt(at) {
    if (typeof at !== "string" || !ISO_AT.test(at)) return false;
    // Date.parse rolls 2026-02-30 over to March 2, so only a round trip proves the date is real.
    const t = Date.parse(at);
    return Number.isFinite(t) && new Date(t).toISOString() === at;
  }

  function shapeError(raw, nowMs) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "event must be a JSON object";
    const unknown = Object.keys(raw).find(function (key) { return FIELDS.indexOf(key) === -1; });
    if (unknown !== undefined) return "unknown field " + unknown;
    if (typeof raw.id !== "string" || !ID.test(raw.id)) return "id must match " + ID;
    if (!FOLD.has(raw.type)) return "type must be one of " + Array.from(FOLD.keys()).join(", ");
    if (raw.type === "undo") {
      const target = raw.id.slice(UNDO_PREFIX.length);
      if (!raw.id.startsWith(UNDO_PREFIX) || !target || target.startsWith(UNDO_PREFIX)) {
        return "undo id must be undo: plus the load id";
      }
    } else if (raw.id.startsWith(UNDO_PREFIX)) {
      return "only an undo id may start with undo:";
    }
    if (PAID.has(raw.type)) {
      if (!Number.isInteger(raw.amount) || raw.amount < 1 || raw.amount > MAX_AMOUNT) {
        return "amount must be a whole number of dollars from 1 to " + MAX_AMOUNT;
      }
    } else if (raw.amount !== undefined) {
      return raw.type + " takes no amount";
    }
    if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > MAX_NOTE)) {
      return "note must be a string of at most " + MAX_NOTE + " characters";
    }
    if (!isIsoAt(raw.at)) return "at must be a UTC timestamp like 2026-10-31T15:00:00.000Z";
    if (Date.parse(raw.at) - nowMs > MAX_AHEAD_MS) return "at is more than an hour in the future";
    return null;
  }

  function canonical(e) {
    const event = { id: e.id, type: e.type };
    if (e.amount !== undefined) event.amount = e.amount;
    if (e.note) event.note = e.note;
    event.at = e.at;
    return event;
  }

  function admit(log, raw, nowMs) {
    const detail = shapeError(raw, nowMs);
    if (detail) return { status: "rejected", code: "invalid_event", detail: detail };
    const event = canonical(raw);
    const stored = log.find(function (e) { return e.id === event.id; });
    if (!stored) return { status: "appended", event: event };
    if (JSON.stringify(canonical(stored)) === JSON.stringify(event)) return { status: "duplicate", event: stored };
    return { status: "rejected", code: "id_conflict", detail: "id " + event.id + " is already stored with a different body" };
  }

  function refuse(detail) {
    return { status: "rejected", code: "invalid_intent", detail: detail };
  }

  function tap(log, intent, newId, nowMs) {
    const view = project(log);
    const newest = log.reduce(function (max, e) { return Math.max(max, Date.parse(e.at)); }, -Infinity);
    const at = new Date(Math.max(nowMs, newest + 1)).toISOString();
    switch (intent.type) {
      case "baba_load":
      case "family_load":
        return admit(log, { id: newId, type: intent.type, at: at }, nowMs);
      case "baba_paid":
        return admit(log, { id: newId, type: intent.type, amount: intent.amount, at: at }, nowMs);
      case "baba_paid_in_full":
        if (view.balance <= 0) return refuse("nothing is owed");
        return admit(log, { id: newId, type: intent.type, amount: view.balance, at: at }, nowMs);
      case "undo":
        if (!view.undo || nowMs >= Date.parse(view.undo.expiresAt)) return refuse("no load to undo");
        return admit(log, { id: view.undo.id, type: "undo", at: at }, nowMs);
      default:
        return refuse("unknown intent " + intent.type);
    }
  }

  function migrationEvent(row) {
    if (!row || typeof row !== "object") return null;
    const type = LEGACY.get(row.type);
    if (!type || !isIsoAt(row.at)) return null;
    const prefix = "m1:" + row.type + ":" + row.at + ":";
    if (!PAID.has(type)) return { id: prefix + (row.fromCredit === true ? "1" : "0"), type: type, at: row.at };
    if (!Number.isInteger(row.amount) || row.amount < 1 || row.amount > MAX_AMOUNT) return null;
    return { id: prefix + row.amount, type: type, amount: row.amount, at: row.at };
  }

  function migrationEvents(v1JsonString) {
    let data;
    try {
      data = JSON.parse(v1JsonString);
    } catch (e) {
      return [];
    }
    if (!data || !Array.isArray(data.history)) return [];
    return data.history.map(migrationEvent).filter(Boolean);
  }

  const api = { project: project, admit: admit, tap: tap, migrationEvents: migrationEvents, money: money };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.LaundryReducer = api;
})();
