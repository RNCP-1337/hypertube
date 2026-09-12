# Hypertube

A web app to search for and watch films that are in the public domain or under a
free licence. Videos are fetched over BitTorrent by the server and streamed to
the player while they download — you do not wait for the file to finish.

The BitTorrent client is written from scratch (bencode, HTTP and UDP trackers,
the peer wire protocol, BEP-9, BEP-10, BEP-19, BEP-47). No `webtorrent`,
`peerflix` or `pulsar`.

---

## Requirements

Docker Desktop. That is all — Node, ffmpeg and PostgreSQL all live inside the
containers. The stack runs natively on Apple Silicon and on Intel: every base
image publishes `linux/arm64` and `linux/amd64`, no dependency is a prebuilt
native binary, and `make` detects the host architecture and builds for it, so
there is no QEMU emulation on either machine.

## Quick start

```sh
make env      # creates .env from .env.example and generates strong secrets
make up       # builds the images and starts everything
```

Then open <http://localhost:8080>.

`make seed` adds two demo accounts (`norminet` / `bocal`, password
`Hypertube42!`) and fills the catalogue with a first page of films.

To stop: `make down`. To wipe everything including downloaded media:
`make fclean`.

## Configuration

`make env` writes a `.env` with random secrets. Everything below is optional —
the app runs without any of it, you just get fewer features.

| Variable | What it unlocks | Where to get it |
| --- | --- | --- |
| `TMDB_API_KEY` | posters, ratings, cast, runtime, summaries | <https://www.themoviedb.org/settings/api> |
| `OMDB_API_KEY` | fallback for the above | <https://www.omdbapi.com/apikey.aspx> |
| `OAUTH_42_*` | sign in with 42 | <https://profile.intra.42.fr/oauth/applications> |
| `OAUTH_GOOGLE_*` | sign in with Google | <https://console.cloud.google.com/apis/credentials> |
| `OAUTH_GITHUB_*` | sign in with GitHub | <https://github.com/settings/developers> |
| `OAUTH_DISCORD_*` | sign in with Discord | <https://discord.com/developers/applications> |
| `OPENSUBTITLES_API_KEY` | subtitles beyond those inside the torrent | <https://www.opensubtitles.com/consumers> |

Each provider's redirect URI is `http://localhost:8080/api/auth/oauth/<id>/callback`,
where `<id>` is `42`, `google`, `github` or `discord`. Only providers whose
credentials are present are offered on the sign-in page.

`.env` is git-ignored and must stay that way.

Password-reset mails are caught by a local Mailpit instance — read them at
<http://localhost:8025>.

## Make targets

```
make help          list everything
make up            build and start (alias: make all)
make down          stop, keep the data
make re            rebuild from scratch
make logs          follow all logs      (logs-backend, logs-frontend)
make ps            container status
make db            psql prompt
make migrate       apply pending migrations
make seed          demo users, films and comments
make reset-db      drop the database volume and start over
make test          run the test suite   (make test-torrent for the engine only)
make typecheck     tsc --noEmit on both sides
make lint          eslint on both sides
make fclean        remove containers, volumes, images and downloaded media
make buildx        build linux/amd64 + linux/arm64 images
```

`lint`, `typecheck` and `test` run inside throwaway containers, so you still do
not need Node on your machine.

## Layout

```
.
├── Makefile
├── docker-compose.yml
├── .env.example
├── nginx/default.conf          serves the SPA, proxies /api, sets the CSP
├── backend/
│   ├── Dockerfile
│   └── src/
│       ├── index.ts            boot: migrate, start the engine, listen
│       ├── app.ts              Fastify assembly, headers, rate limiting
│       ├── config/             env parsing and validation
│       ├── db/                 pool, migration runner, SQL migrations, seed
│       ├── lib/                jwt, scrypt, validation, mailer, http, cache
│       ├── middleware/         auth guards, error handling
│       ├── routes/             auth, oauth, users, movies, stream, comments
│       ├── services/           catalogue, metadata, subtitles, transcode,
│       │   └── sources/        the external film sources
│       └── torrent/            the BitTorrent client
│           ├── bencode.ts      BEP-3 codec
│           ├── metainfo.ts     .torrent and magnet parsing, info-hash
│           ├── trackers.ts     HTTP (BEP-3/23) and UDP (BEP-15) announces
│           ├── wire.ts         handshake, messages, framing, bitfield
│           ├── peer.ts         one peer connection, BEP-9/10 metadata
│           ├── pieces.ts       block bookkeeping, SHA-1, the piece picker
│           ├── storage.ts      piece <-> file mapping, sparse writes
│           ├── webseed.ts      BEP-19 HTTP seeding
│           ├── torrent.ts      swarm, availability, streaming readiness
│           └── engine.ts       active torrents, inbound peers, persistence
└── frontend/
    ├── Dockerfile
    └── src/                    React + TypeScript + Tailwind SPA
```

## How the video part works

**Starting a film.** `POST /api/movies/:id/play` resolves the best torrent for
the movie and hands it to the engine, then returns immediately. Everything after
that happens in the background: tracker announces, peer connections, metadata
exchange over BEP-9 when the source only gave us a magnet link.

**Getting playable data first.** The piece picker is sequential and follows a
playhead rather than being rarest-first. When metadata arrives, the playhead is
placed at the start of the film file — a torrent often bundles other material
before it — and the tail of the file is pinned too, because an MP4 that was not
written "faststart" keeps its index at the end and no player can begin without
it. Playback is announced as ready once the head and the tail are on disk, which
in practice takes a handful of seconds.

**Serving it.** `GET /api/movies/:id/stream` turns the browser's `Range` header
into a piece range, moves the playhead there, waits for exactly those pieces and
streams them off disk with a `206`. Each response covers a bounded window, so
the server never waits for more of the torrent than the player asked for.

**Formats.** `mp4`, `m4v` and `webm` are served untouched. Anything else — `mkv`
first of all, plus `avi`, `mov`, … — is converted on the fly by ffmpeg into
fragmented MP4 and piped straight to the response. Streams are copied rather
than re-encoded whenever the codecs are already browser-friendly, so a typical
mkv costs almost nothing. The ffmpeg process is killed as soon as the client
disconnects.

**Where the bytes come from.** Peers first, over the real peer wire protocol.
Torrents that advertise `url-list` also get BEP-19 HTTP seeding in parallel,
which is what keeps playback smooth on legal sources whose swarms are small.
Either way every piece is SHA-1 checked against the metainfo before it is
written, and a piece that does not match is thrown away and re-fetched.

**Subtitles.** Files shipped inside the torrent, tracks embedded in the
container, and OpenSubtitles when a key is configured — all normalised to
WebVTT. A subtitle file is fetched as a pinned side request so it does not steal
the playhead from the video.

**Retention.** A completed film stays on disk so it is never downloaded twice.
An hourly job erases anything not watched for `MEDIA_RETENTION_DAYS` (30 by
default) and cleans up directories no download row references any more.

## Sources

Two external sources are queried in parallel, both distributing public-domain or
Creative-Commons material:

- **Internet Archive** — <https://archive.org>, via its public search API,
  restricted to its curated film collections.
- **Public Domain Torrents** — <http://www.publicdomaintorrents.info>.

A source that is slow or down never breaks the page; its results are simply
missing. Results are merged, enriched with metadata and stored, which is what
gives the library reliable pagination, sorting and filtering.

## REST API

OAuth2 bearer authentication. Get a token, then send
`Authorization: Bearer <token>`:

```sh
curl -X POST http://localhost:8080/api/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"...","client_secret":"..."}'
```

The client id and secret are the `API_CLIENT_ID` / `API_CLIENT_SECRET` values in
your `.env`. Four grants are supported: `client_credentials`, `password`,
`authorization_code` and `refresh_token`, with `read` and `write` scopes.

The full route list, with payloads and status codes, is served at
<http://localhost:8080/api/docs> (HTML in a browser, JSON otherwise).

Highlights:

```
GET    /api/movies                 front page / library, public
GET    /api/movies/:id             everything known about a film
GET    /api/users                  id + username
GET    /api/users/:id              profile; e-mail only for its owner
PATCH  /api/users/:id              own profile only, 403 otherwise
GET    /api/comments               latest comments
GET    /api/comments/:id
POST   /api/comments               or POST /api/movies/:id/comments
PATCH  /api/comments/:id           author only
DELETE /api/comments/:id           author only
```

Anything else returns `404`.

## Security

- Passwords are hashed with scrypt (memory-hard, from Node's `crypto`), salted
  per user and compared in constant time. Nothing is ever stored in clear.
- Every SQL statement is parameterised. No user input is ever concatenated into
  a query, and the sortable columns are a fixed whitelist.
- Every request body, query string and route parameter is parsed by a schema
  before it reaches a handler; failures return `422` with the offending fields.
- React escapes all output and the app never uses `dangerouslySetInnerHTML`, so
  a comment cannot inject markup. nginx also sends a Content-Security-Policy
  that forbids inline scripts and `eval`.
- Uploaded pictures must pass a MIME check, a size cap and a magic-byte check,
  and are then re-encoded through ffmpeg, which strips EXIF and any embedded
  payload — a file that is not really an image simply fails to decode. Stored
  names are generated, and the files are served with a fixed `Content-Type` and
  `nosniff`.
- The session is a short-lived access token held in memory plus a rotating,
  single-use refresh token in an httpOnly `SameSite=Strict` cookie. Only the
  SHA-256 digest of the refresh token is stored, so a database dump cannot be
  replayed. Changing a password revokes every session.
- The OmniAuth `state` is an HMAC mirrored in a short-lived cookie, checked in
  constant time on the callback.
- Login and password-reset answers are deliberately uniform so neither can be
  used to enumerate accounts. Both are rate limited, as is the whole API.
- JWT verification pins HS256 — no `alg: none` downgrade — and checks the
  signature in constant time.
- Torrent file paths are sanitised at parse time and checked again against the
  storage root before any file is opened.

## Tests

```sh
make test
```

35 tests covering the parts where a bug is silent rather than loud: the bencode
codec and info-hash computation, magnet parsing, the handshake and message
framing (fed one byte at a time), the bitfield, compact peer lists, the flat
address space to file mapping, out-of-order sparse writes, SHA-1 verification
and corrupt-piece rejection, hostile block rejection, and the piece picker's
ordering, pinning and duplicate-request behaviour.

## Notes

Only royalty-free or legally distributable material is indexed. Both configured
sources distribute public-domain or Creative-Commons films. If you add a source,
it is on you to check it is lawful where you are.
