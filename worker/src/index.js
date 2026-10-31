import { DurableObject } from "cloudflare:workers";
import reducer from "../../reducer.js";

const { project, admit } = reducer;

const CORS = {
  "Access-Control-Allow-Origin": "https://just-curious148.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const PATH = /^\/s\/([^/]+)\/api(\/[a-z]+)$/;

const ROUTES = {
  "/state": { method: "GET", run: async (ledger) => json(200, await ledger.snapshot()) },
  "/balance": {
    method: "GET",
    run: async (ledger) => {
      const { balance, updatedAt } = await ledger.snapshot();
      return json(200, { balance, updatedAt });
    },
  },
  "/history": { method: "GET", run: async (ledger) => json(200, { history: (await ledger.snapshot()).history }) },
  "/events": { method: "POST", run: postEvent },
};

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...headers },
  });
}

function secretMatches(segment, expected) {
  if (typeof expected !== "string" || expected === "") return false;
  let given;
  try {
    given = decodeURIComponent(segment);
  } catch {
    return false;
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function postEvent(ledger, request) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: "bad_event" });
  }
  const result = await ledger.append(raw);
  if (result.status === "rejected") {
    return result.code === "id_conflict" ? json(409, { error: "id_conflict" }) : json(400, { error: "bad_event" });
  }
  return json(result.status === "appended" ? 201 : 200, {
    result: result.status,
    event: result.event,
    balance: result.balance,
    updatedAt: result.updatedAt,
  });
}

async function route(request, env) {
  const match = PATH.exec(new URL(request.url).pathname);
  const known = match && ROUTES[match[2]];
  if (!known || !secretMatches(match[1], env.ACCESS_SECRET)) return json(404, { error: "not_found" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== known.method) {
    return json(405, { error: "method_not_allowed" }, { Allow: known.method + ", OPTIONS" });
  }
  return known.run(env.LEDGER.get(env.LEDGER.idFromName("family")), request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return json(500, { error: "internal" });
    }
  },
};

export class LaundryLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, received_at TEXT NOT NULL)");
  }

  #read() {
    const events = this.sql.exec("SELECT body FROM events ORDER BY rowid").toArray().map((row) => JSON.parse(row.body));
    const updatedAt = this.sql.exec("SELECT MAX(received_at) AS updatedAt FROM events").one().updatedAt;
    return { events, updatedAt };
  }

  snapshot() {
    const { events, updatedAt } = this.#read();
    return { ...project(events), events, updatedAt };
  }

  // Keep any await out of the gap between admit and INSERT. The object's single
  // thread is what makes the id check and the write one atomic step.
  append(raw) {
    const nowMs = Date.now();
    const result = admit(this.#read().events, raw, nowMs);
    if (result.status === "rejected") return result;
    if (result.status === "appended") {
      this.sql.exec(
        "INSERT INTO events (id, body, received_at) VALUES (?, ?, ?)",
        result.event.id,
        JSON.stringify(result.event),
        new Date(nowMs).toISOString()
      );
    }
    const { events, updatedAt } = this.#read();
    return { status: result.status, event: result.event, balance: project(events).balance, updatedAt };
  }
}
