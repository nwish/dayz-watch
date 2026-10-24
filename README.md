# dayz-watch

Watches DayZ servers from a small web UI and, if a Discord webhook is configured, posts whenever a server's player count changes.

It polls each server with the Steam A2S_INFO query (UDP). DayZ answers on **game port + 1**: for a server on 11300, add query port `11301`.

## Run with Docker

```sh
cp compose.yaml.example compose.yaml   # git ignores compose.yaml, so local edits stay out of the repo
cp .env.example .env   # optional: set ADMIN_PASSWORD, DISCORD_WEBHOOK_URL, ...
docker compose up -d --build
docker compose logs dayz-watcher   # shows the generated admin password if you didn't set one
```

Open `http://<host>:8080` and sign in. Everything else (servers, users) is managed in the UI.

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Username of the first admin. Only used while no users exist. |
| `ADMIN_PASSWORD` | generated | Password of the first admin (10-128 chars). Only used while no users exist; if empty, a random one is printed once in the container log. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy: the client IP for rate limiting is taken from the last `X-Forwarded-For` entry (the one your proxy appended), and `X-Forwarded-Proto`/`-Host` are honoured. Only enable it if the container is reachable *only* through that proxy, otherwise clients can spoof their IP. |
| `COOKIE_SECURE` | `false` | Mark the session cookie `Secure`. Set `true` when served over HTTPS (implied by `TRUST_PROXY=true` when the proxy sends `X-Forwarded-Proto: https`). |
| `DISCORD_WEBHOOK_URL` | unset | Default webhook, used by servers added without their own. Optional: with no webhook at all, servers are still monitored in the UI but nothing is posted. |
| `POLL_SECONDS` | 30 | Poll interval (minimum 5). |
| `DIRECTORY_URL` | DZSA Launcher list | JSON list of public servers used by the add-server search (see below). Override only to point at a compatible mirror. |
| `HOST_PORT` | 8080 | Host port published by compose (the container itself always listens on 8080). |

Data lives in the `dayz-watch-data` volume: `servers.json` (per-server webhook URLs in plain text, never returned by the API) and `users.json` (scrypt password hashes, file mode 600).

The container needs outbound UDP to the query ports and outbound HTTPS to Discord. Put TLS in front of it (reverse proxy) for anything beyond a trusted LAN: the login form sends the password in the clear over plain HTTP.

## Accounts and login

- Sessions are server-side, in an `HttpOnly`, `SameSite=Strict` cookie; they expire after 12 h idle or 7 days total and are lost when the container restarts.
- **Roles:** `admin` can do everything including user management; `user` can view and manage servers but not users.
- **Admin → Users:** add users, make/unmake admins, reset passwords, delete. Resetting a password or deleting a user signs that user out immediately. You can't delete yourself or change your own role, and the last admin can't be demoted or deleted.
- **Account:** any user can change their own password (needs the current one; their other sessions are signed out).
- Usernames are 3-32 characters of `a-z 0-9 . _ -` (case-insensitive). Passwords are 10-128 characters.
- **Rate limiting** applies to failed logins: 10 failures per username or 20 per client IP within 15 minutes locks that username/IP for 15 minutes (HTTP 429 with `Retry-After`). A locked key is refused before the password is checked. Counters are in memory and reset on restart. Trade-off: anyone can lock a known username out for 15 minutes by guessing wrongly; other accounts and valid sessions are unaffected.
- State-changing requests must be JSON and, if they carry an `Origin` header, same-origin.

## Behaviour

- First reading after start or add is a silent baseline.
- A post is sent only when the count differs from the previous successful reading, e.g. `**Name** (map): players 5 → **6**/60 (+1)`.
- A failed query (timeout, DNS) is shown in the UI and is not treated as a change. A server restart shows as a drop to 0 and a climb back.

## Finding servers to add

The *Add server* form has a search box. Type part of a server name, number (e.g. `2305`), map, or IP (`85.190.157.254` or `ip:port`) and pick a result: it fills in the host and query port. All words you type must match; name-prefix matches rank first, then busier servers. Typing host and port by hand still works.

The list comes from the DZSA Launcher's public endpoint (`https://dayzsalauncher.com/api/v2/launcher/servers/dayz`, ~10k servers, no API key). BattleMetrics and the Steam Web API both need a paid or keyed account now, so they aren't used. The container downloads the list (~13 MB) on the first search, keeps a trimmed copy in memory, and refreshes it after 10 minutes. If a refresh fails it keeps serving the old list; if the very first download fails the search box shows an error and manual entry still works. This is a community endpoint with no SLA, and the container needs outbound HTTPS to it.

## Server overlay

Click a server row to open a large overlay with the live player count plus basic info (address, game port, map, version, platform, in-game time, BattlEye, third person, password). While it is open, any change in player count plays a three-beat alert (rising tones for joins, falling for leaves), flashes the window green or red, and shows `+N joined` / `−N left` with the time. The `Sound` button mutes the beep; Esc, the × button, or a click outside closes it.

Browsers only allow audio after a user gesture, so sound is enabled by the click that opens the overlay. The overlay sees changes as fast as the server is polled (`POLL_SECONDS`), so a 30 s poll means up to 30 s before an alert.

The overlay is themed by the server's map (colours, sky gradient, and a landscape drawn as inline SVG):

| Map (A2S name) | Theme |
|---|---|
| `nasdara`, `takistan`, `takistanplus` | Desert |
| `enoch` (Livonia) | Forest |
| `chernarusplus` (and any `chernarus*` variant) | Temperate |
| `namalsk` | Arctic |
| `sakhal` | Frozen island (aurora) |
| `deerisle` | Coastal |
| `esseker` | Harvest |
| anything else | Default (light grey by day, dark by night) |

Every theme has a **day** and a **night** variant, chosen from the server's in-game clock (the `HH:MM` DayZ puts in the A2S keywords): day is 06:00–17:59, night is 18:00–05:59. Day is a bright sky with a sun or clouds and dark text; night is a dark sky with stars and a moon (Sakhal gets an aurora, Arctic keeps its snowflakes). The card switches live if the clock crosses 06:00 or 18:00 while it is open. A server that reports no in-game time gets the day variant.

To add a map, add an entry to `MAP_THEME` in `public/index.html` (and a new entry in `THEMES` with `day` and `night` variants if it needs its own look). Match is on the map name lower-cased with non-letters removed.

## Development

```sh
npm test                                   # node:test, no dependencies
DISCORD_WEBHOOK_URL=... node src/server.js # data in ./data
```
