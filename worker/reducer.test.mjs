import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const R = require("../reducer.js");

const T0 = "2026-10-31T15:00:00.000Z";
const T1 = "2026-10-31T15:01:00.000Z";
const T2 = "2026-10-31T15:02:00.000Z";
const T3 = "2026-10-31T15:03:00.000Z";
const NOW = Date.parse("2026-10-31T15:10:00.000Z");

function load(id, at, type) {
  const event = { id: id, type: type, at: at };
  return event;
}

test("money formats the headline the way the page does", () => {
  assert.equal(R.money(0), "$0.00");
  assert.equal(R.money(2), "$2.00");
  assert.equal(R.money(-2), "-$2.00");
});

test("an empty log is a zero book", () => {
  const view = R.project([]);
  assert.deepEqual(
    {
      balance: view.balance,
      dadUnpaid: view.dadUnpaid,
      otherUnpaid: view.otherUnpaid,
      credit: view.credit,
      history: view.history,
      ledger: view.ledger,
      undo: view.undo,
    },
    {
      balance: 0,
      dadUnpaid: 0,
      otherUnpaid: 0,
      credit: 0,
      history: [],
      ledger: [],
      undo: null,
    }
  );
});

test("a Baba load and a family load raise the matching chip", () => {
  const view = R.project([
    load("a", T0, "baba_load"),
    load("b", T1, "family_load"),
  ]);
  assert.equal(view.balance, 3);
  assert.equal(view.dadUnpaid, 1);
  assert.equal(view.otherUnpaid, 1);
  assert.equal(view.credit, 0);
  assert.equal(view.history[0].type, "add-family");
  assert.equal(view.history[0].label, "Family load +$1");
  assert.equal(view.history[0].fromCredit, false);
  assert.equal(view.history[1].type, "add-dad");
  assert.equal(view.history[1].label, "Baba's load +$2");
  assert.deepEqual(view.ledger.map((row) => row.amt), [2, 1]);
  assert.equal(view.undo.id, "undo:b");
  assert.equal(view.undo.expiresAt, "2026-10-31T15:03:00.000Z");
});

test("replay follows at, not input order", () => {
  const forward = R.project([
    load("a", T0, "baba_load"),
    load("b", T1, "family_load"),
  ]);
  const backward = R.project([
    load("b", T1, "family_load"),
    load("a", T0, "baba_load"),
  ]);
  assert.equal(backward.balance, forward.balance);
  assert.deepEqual(backward.history.map((row) => row.id), forward.history.map((row) => row.id));
});

test("one dad load and two $1 payments leave the chip and put $2 on credit", () => {
  const view = R.project([
    load("a", T0, "baba_load"),
    { id: "p1", type: "baba_paid", amount: 1, at: T1 },
    { id: "p2", type: "baba_paid", amount: 1, at: T2 },
  ]);
  assert.equal(view.dadUnpaid, 1);
  assert.equal(view.otherUnpaid, 0);
  assert.equal(view.credit, 2);
  assert.equal(view.balance, 0);
  assert.equal(view.history[0].label, "Baba paid $1.00");
  assert.equal(view.undo, null);
});

test("$3 against two dad loads retires one load and keeps $1 credit", () => {
  const view = R.project([
    load("a", T0, "baba_load"),
    load("b", T1, "baba_load"),
    { id: "p", type: "baba_paid", amount: 3, at: T2 },
  ]);
  assert.equal(view.dadUnpaid, 1);
  assert.equal(view.credit, 1);
  assert.equal(view.balance, 1);
  assert.equal(view.history[0].label, "Baba paid $3.00");
});

test("$1 against one dad load and one family load retires the family load", () => {
  const view = R.project([
    load("a", T0, "baba_load"),
    load("b", T1, "family_load"),
    { id: "p", type: "baba_paid", amount: 1, at: T2 },
  ]);
  assert.equal(view.dadUnpaid, 1);
  assert.equal(view.otherUnpaid, 0);
  assert.equal(view.credit, 0);
  assert.equal(view.balance, 2);
});

test("overpaying with nothing owed shows a negative balance", () => {
  const view = R.project([{ id: "p", type: "baba_paid", amount: 5, at: T0 }]);
  assert.equal(view.balance, -5);
  assert.equal(view.credit, 5);
  assert.equal(view.history[0].label, "Baba paid $5.00 (extra $5.00)");
});

test("a load spends whole-load credit before it raises a chip", () => {
  const view = R.project([
    { id: "p", type: "baba_paid", amount: 5, at: T0 },
    load("a", T1, "baba_load"),
  ]);
  assert.equal(view.dadUnpaid, 0);
  assert.equal(view.credit, 3);
  assert.equal(view.balance, -3);
  assert.equal(view.history[0].label, "Baba's load +$2 (from extra paid)");
  assert.equal(view.history[0].fromCredit, true);
  assert.equal(view.ledger[1].t, "load");
  assert.equal(view.ledger[1].amt, 2);
});

test("pay in full while credit is nonzero zeros the book and records that balance", () => {
  const before = R.project([
    load("a", T0, "baba_load"),
    { id: "p", type: "baba_paid", amount: 1, at: T1 },
  ]);
  assert.equal(before.balance, 1);
  assert.equal(before.dadUnpaid, 1);
  assert.equal(before.credit, 1);
  const view = R.project([
    load("a", T0, "baba_load"),
    { id: "p", type: "baba_paid", amount: 1, at: T1 },
    { id: "f", type: "baba_paid_in_full", amount: 1, at: T2 },
  ]);
  assert.equal(view.dadUnpaid, 0);
  assert.equal(view.otherUnpaid, 0);
  assert.equal(view.credit, 0);
  assert.equal(view.balance, 0);
  assert.equal(view.history[0].type, "pay-full");
  assert.equal(view.history[0].label, "Baba paid in full $1.00");
  assert.equal(view.history[0].amount, 1);
  assert.equal(view.ledger[view.ledger.length - 1].amt, 1);
});

test("pay in full still zeros the book when the recorded amount is not the folded balance", () => {
  const view = R.project([
    load("a", T0, "baba_load"),
    { id: "f", type: "baba_paid_in_full", amount: 5, at: T1 },
  ]);
  assert.equal(view.balance, 0);
  assert.equal(view.dadUnpaid, 0);
  assert.equal(view.credit, 0);
  assert.equal(view.ledger[view.ledger.length - 1].amt, 5);
  assert.equal(view.history[0].label, "Baba paid in full $5.00");
});

test("pay in full at a zero or negative balance adds no row", () => {
  const view = R.project([
    { id: "p", type: "baba_paid", amount: 5, at: T0 },
    { id: "f", type: "baba_paid_in_full", amount: 1, at: T1 },
  ]);
  assert.equal(view.balance, -5);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].type, "pay");
});

test("undo removes only the newest load inside the two minute window", () => {
  const undone = R.project([
    { id: "p", type: "baba_paid", amount: 5, at: T0 },
    load("a", T1, "baba_load"),
    { id: "undo:a", type: "undo", at: "2026-10-31T15:01:30.000Z" },
  ]);
  assert.equal(undone.credit, 5);
  assert.equal(undone.balance, -5);
  assert.equal(undone.dadUnpaid, 0);
  assert.equal(undone.history.length, 1);
  assert.equal(undone.ledger.length, 1);

  const chain = R.project([
    load("a", "2026-10-31T15:00:00.000Z", "baba_load"),
    load("b", "2026-10-31T15:00:30.000Z", "family_load"),
    { id: "undo:b", type: "undo", at: "2026-10-31T15:01:00.000Z" },
    { id: "undo:a", type: "undo", at: "2026-10-31T15:01:10.000Z" },
  ]);
  assert.equal(chain.balance, 0);
  assert.equal(chain.history.length, 0);

  const tooLate = R.project([
    load("a", T0, "baba_load"),
    { id: "undo:a", type: "undo", at: "2026-10-31T15:02:00.000Z" },
  ]);
  assert.equal(tooLate.dadUnpaid, 1);
  assert.equal(tooLate.history.length, 1);

  const blocked = R.project([
    load("a", T0, "baba_load"),
    { id: "p", type: "baba_paid", amount: 1, at: T1 },
    { id: "undo:a", type: "undo", at: "2026-10-31T15:01:30.000Z" },
  ]);
  assert.equal(blocked.dadUnpaid, 1);
  assert.equal(blocked.history[0].type, "pay");
});

test("a repeated id is one event", () => {
  const once = R.project([load("a", T0, "baba_load")]);
  const twice = R.project([load("a", T0, "baba_load"), load("a", T0, "baba_load")]);
  assert.equal(twice.balance, once.balance);
  assert.equal(twice.history.length, 1);
});

test("admit is idempotent by id and rejects a reused id with a different body", () => {
  const first = R.admit([], { id: "a", type: "baba_load", at: T0 }, NOW);
  assert.equal(first.status, "appended");
  const again = R.admit([first.event], { id: "a", type: "baba_load", at: T0 }, NOW);
  assert.equal(again.status, "duplicate");
  const clash = R.admit([first.event], { id: "a", type: "family_load", at: T0 }, NOW);
  assert.equal(clash.status, "rejected");
  assert.equal(clash.code, "id_conflict");
  const bad = R.admit([], { id: "p", type: "baba_paid", at: T0 }, NOW);
  assert.equal(bad.status, "rejected");
});

test("tap stamps the pay-in-full amount and the undo id", () => {
  const added = R.tap([], { type: "baba_load" }, "a", Date.parse(T0));
  assert.equal(added.status, "appended");
  assert.equal(added.event.id, "a");
  assert.equal(added.event.at, T0);
  const full = R.tap([added.event], { type: "baba_paid_in_full" }, "f", Date.parse(T1));
  assert.equal(full.status, "appended");
  assert.equal(full.event.amount, 2);
  assert.equal(full.event.type, "baba_paid_in_full");
  const undone = R.tap([added.event], { type: "undo" }, "ignored", Date.parse(T1));
  assert.equal(undone.status, "appended");
  assert.equal(undone.event.id, "undo:a");
  const idle = R.tap([], { type: "undo" }, "x", Date.parse(T0));
  assert.equal(idle.status, "rejected");
  const nothingOwed = R.tap([], { type: "baba_paid_in_full" }, "f", Date.parse(T0));
  assert.equal(nothingOwed.status, "rejected");
});

test("migration ids are a pure function of the legacy row", () => {
  const raw = JSON.stringify({
    dadUnpaid: 9,
    credit: 9,
    history: [
      { type: "pay-full", label: "Baba paid in full $7.00", at: T3, amount: 7 },
      { type: "pay", label: "Baba paid $5.00", at: T2, amount: 5 },
      { type: "add-dad", label: "Baba's load +$2", at: T1, fromCredit: false },
      { type: "add-family", label: "Family load +$1 (from extra paid)", at: T0, fromCredit: true },
      { type: "add-dad", label: "skip me", at: "yesterday", fromCredit: false },
    ],
  });
  const events = R.migrationEvents(raw);
  const again = R.migrationEvents(raw);
  assert.deepEqual(again.map((event) => event.id), events.map((event) => event.id));
  assert.deepEqual(events.map((event) => event.id).sort(), [
    "m1:add-dad:" + T1 + ":0",
    "m1:add-family:" + T0 + ":1",
    "m1:pay-full:" + T3 + ":7",
    "m1:pay:" + T2 + ":5",
  ]);
  const family = events.find((event) => event.id.indexOf("add-family") !== -1);
  assert.equal(family.type, "family_load");
  assert.equal(family.amount, undefined);
  const paid = events.find((event) => event.type === "baba_paid");
  assert.equal(paid.amount, 5);
  const full = events.find((event) => event.type === "baba_paid_in_full");
  assert.equal(full.amount, 7);
});
