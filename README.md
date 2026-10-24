# dayz-watch

Watches DayZ servers from a small web UI and, if a Discord webhook is configured, posts whenever a server's player count changes.

It polls each server with the Steam A2S_INFO query (UDP). DayZ answers on **game port + 1**: for a server on 11300, add query port `11301`.

## Run with Docker

```sh
cp .env.example .env   # set ADMIN_PASSWORD (and optionally DISCORD_WEBHOOK_URL)
docker compose up -d --build
```

Open `http://<host>:8080`, log in with any username and your `ADMIN_PASSWORD`, and add servers.

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | unset | HTTP basic auth for the UI/API. If unset the UI is open to anyone who can reach the port. |
| `DISCORD_WEBHOOK_URL` | unset | Default webhook, used by servers added without their own. Optional: with no webhook at all, servers are still monitored in the UI but nothing is posted. |
| `POLL_SECONDS` | 30 | Poll interval (minimum 5). |
| `PORT` | 8080 | Host port published by compose (container always listens on 8080). |

Server list is stored in the `dayz-watch-data` volume (`/data/servers.json`). Per-server webhook URLs are stored there in plain text and are never returned by the API.

The container needs outbound UDP to the query ports and outbound HTTPS to Discord. Behind a reverse proxy, add TLS there: basic auth over plain HTTP is readable on the wire.

## Behaviour

- First reading after start or add is a silent baseline.
- A post is sent only when the count differs from the previous successful reading, e.g. `**Name** (map): players 5 → **6**/60 (+1)`.
- A failed query (timeout, DNS) is shown in the UI and is not treated as a change. A server restart shows as a drop to 0 and a climb back.

## Development

```sh
npm test                                   # node:test, no dependencies
DISCORD_WEBHOOK_URL=... node src/server.js # data in ./data
```
