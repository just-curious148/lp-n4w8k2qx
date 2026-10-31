# How to deploy and use the Laundry Pay sync Worker

The Worker stores every load and payment as an event in one Durable Object. The page and any script read the same balance and history from it.

The access secret is a path segment in every API URL: `/s/<SECRET>/api/...`. Anyone who has the URL can read and write the book. Keep the secret out of git, chat, and screenshots. It is never committed. `worker/.dev.vars` is in `.gitignore`.

## Create a secret

Generate a value that the page accepts (8 to 256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`):

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

## Deploy

Run these commands from the `worker/` directory.

1. Deploy the Worker and its Durable Object:

	```sh
	npx wrangler deploy
	```

2. Set the secret. Paste the value from the previous section when wrangler asks for it:

	```sh
	npx wrangler secret put ACCESS_SECRET
	```

Until `ACCESS_SECRET` is set, every route returns 404.

## Run it locally

Create `worker/.dev.vars` with one line:

```
ACCESS_SECRET=paste-your-secret-here
```

Then start the local Worker:

```sh
npx wrangler dev
```

## Connect each device

Open the page once on each phone or computer with the secret in the fragment:

```
https://just-curious148.github.io/lp-n4w8k2qx/#k=<SECRET>
```

The page saves the secret in `localStorage` and removes the fragment from the address bar. Without a secret, the page still works offline and queues taps, but it does not send them.

## Call the API from a script

Set two shell variables first:

```sh
SECRET=paste-your-secret-here
API="https://laundry-pay-sync.enchanted-haumea.workers.dev/s/$SECRET/api"
```

Every event needs an `id` that you choose and an `at` in UTC with milliseconds. To retry a request safely, send the same `id` and body again. The Worker answers `200` with `"result":"duplicate"` and does not add a second load.

Add a Baba load (+$2):

```sh
curl -s -X POST "$API/events" -H 'Content-Type: application/json' \
	-d "{\"id\":\"script-$(uuidgen)\",\"type\":\"baba_load\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
```

Add a family load (+$1):

```sh
curl -s -X POST "$API/events" -H 'Content-Type: application/json' \
	-d "{\"id\":\"script-$(uuidgen)\",\"type\":\"family_load\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
```

Read the balance:

```sh
curl -s "$API/balance"
```

The response looks like `{"balance":3,"updatedAt":"2026-10-31T15:01:00.123Z"}`. A negative balance means Baba paid extra.

Undo the newest load. `GET /state` gives the undo id in `undo.id`. If `undo` is `null`, there is nothing to undo:

```sh
UNDO_ID=$(curl -s "$API/state" | jq -r '.undo.id')
curl -s -X POST "$API/events" -H 'Content-Type: application/json' \
	-d "{\"id\":\"$UNDO_ID\",\"type\":\"undo\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
```

The undo changes the book only if its `at` is less than two minutes after the load's `at` and no other load or payment came in between. Otherwise the Worker stores the undo and the balance stays the same.

## Routes

All routes sit under `/s/<SECRET>/api`.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/state` | `balance`, `dadUnpaid`, `otherUnpaid`, `credit`, `undo`, `history`, `ledger`, `events`, `updatedAt` |
| `GET` | `/balance` | `balance`, `updatedAt` |
| `GET` | `/history` | `history`, newest first |
| `POST` | `/events` | `201` appended, `200` duplicate, `409` `id_conflict`, `400` `bad_event` |

A wrong secret or an unknown path returns `404`. A known path with the wrong method returns `405`.
