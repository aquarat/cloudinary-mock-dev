# cloudinary-mock-dev

This app came into being after I found I need to run some tests on a large media dataset and a Cloudinary dev account wasn't going to cut it. 

This app is largely vibe-coded. Some security hardening has been done, but as always, take precautions.
Also note that this app supports a sub-set of Cloudinary functionality - enough to be useful for me for testing. It is intended as a development aid, not a production service.

And now I'll hand over to the AI agent's README:

A small, self-hosted stand-in for [Cloudinary](https://cloudinary.com), intended for local development and testing. It mimics enough of Cloudinary's Upload API and delivery-URL scheme that an application using a Cloudinary SDK (e.g. the Ruby `cloudinary` gem) can be pointed at this server instead of the real service — no code changes, just configuration.

It is **not** a general-purpose Cloudinary replacement: it stores originals and serves them back verbatim. See [Limitations](#limitations).

This project is not affiliated with or endorsed by Cloudinary.

> **⚠️ This is a development tool.** Do not expose it to the untrusted public internet without the hardening described in [Security](#security) below. It is designed for local development and trusted-network use.

## What it implements

**Upload API** (mimics `api.cloudinary.com/v1_1/...`):

| Endpoint | Notes |
| --- | --- |
| `POST /v1_1/:cloud_name/:resource_type/upload` | `resource_type` may be `image`, `video`, `raw`, or `auto` (detected from content type). Accepts multipart file uploads, remote `http(s)://` URLs, and `data:` URIs as the `file` param. Supports signed uploads (api_key + signature verification) and unsigned uploads via `upload_preset`. Honours `public_id`, `folder`, `type`, `format`, and `tags` params, and returns a Cloudinary-shaped JSON response (`public_id`, `version`, `secure_url`, dimensions, etc.). |
| `POST /v1_1/:cloud_name/upload` | The same upload with no resource type in the path, which Cloudinary treats as an image upload. Browser uploaders that post to `api.cloudinary.com/v1_1/<cloud>/upload` use this form. |
| `POST /v1_1/:cloud_name/:resource_type/destroy` | Signed. Deletes the asset record and its stored bytes. |
| `POST /v1_1/:cloud_name/:resource_type/tags` | Signed. Supports the `add`, `remove`, `replace`, and `remove_all` commands (matches `Cloudinary::Uploader.*_tags`). |
| `GET /health` | Returns `{"status": "ok"}`; used by the Docker healthcheck. |

**Delivery** (mimics `res.cloudinary.com/<cloud_name>/...`):

```
GET /:cloud_name/:resource_type/:type/[transformations/][vN/]:public_id.:format
```

Transformation segments (e.g. `c_fill,w_600`) and version segments (`v1234`) in the path are accepted and ignored — the originally-uploaded bytes are always served, with the correct `Content-Type` for the stored format.

With `DELIVERY_FALLBACK_URLS` set, a delivery request for an asset the clone does not hold is redirected (302) to the same path under a fallback base instead of answering 404. See [Falling back to a real cloud](#falling-back-to-a-real-cloud).

Upload responses build their `url`/`secure_url` against this same server, so an app that stores the returned URL will fetch assets back from the clone.

**Storage:** asset metadata lives in a SQLite database (`assets.sqlite`) and file bytes on disk under `blobs/`, both inside `DATA_DIR`. A structured access log is written to `DATA_DIR/access.log`.

**Admin UI** (optional, off by default): a small React browser app at `/admin` for browsing and deleting stored assets. See [Admin UI](#admin-ui).

## Requirements

- [Bun](https://bun.sh) 1.x (the server uses `bun:sqlite` and `Bun.write`, so Node.js won't work), **or**
- Docker / Docker Compose.

## Setup

### Running locally with Bun

```sh
bun install
bun run dev      # watch mode, or: bun run start
```

The server listens on `PORT` (default 3000) and stores data in `DATA_DIR` (default `./data`).

### Running with Docker Compose

`docker-compose.yml` is gitignored (it carries your local credentials), so start from the example:

```sh
cp docker-compose.yml.example docker-compose.yml
# edit the environment block to match your app's Cloudinary credentials
docker compose up --build
```

The example maps host port **33000** → container port 3000 and persists data in a named volume (`cloudinary-data`).

### Configuration

All configuration is via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where the SQLite DB, blobs, and access log are stored. |
| `CLOUDINARY_CLOUD_NAME` | `some-name-test` | Cloud name to accept; requests for any other cloud name get a 401. |
| `CLOUDINARY_API_KEY` | `123456789` | API key checked on signed requests. |
| `CLOUDINARY_API_SECRET` | `abcdef1234567890` | Secret used to verify request signatures (Cloudinary's SHA-1 scheme). |
| `PUBLIC_BASE_URL` | *(unset)* | Overrides the base URL used when building asset URLs in upload responses. When unset, the incoming request's `Host` header (and `X-Forwarded-Proto`) is used. |
| `REQUIRE_SIGNED_UPLOADS` | *(unset)* | Set to `1` to refuse unsigned uploads: every upload must then carry a valid signature whose `timestamp` is within an hour of now. See [Exposed instances](#exposed-instances). |
| `CORS_ORIGINS` | *(unset)* | Comma-separated list of exact origins (for example `https://app.example.test,https://admin.example.test`) allowed to call the Upload API from a browser. When unset, no CORS headers are sent. |
| `DELIVERY_FALLBACK_URLS` | *(unset)* | Comma-separated delivery bases, such as `https://res.cloudinary.com/my-real-cloud`, to redirect a delivery miss to. Unset keeps the plain 404. See [Falling back to a real cloud](#falling-back-to-a-real-cloud). |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Maximum accepted size of one file, in bytes, however it arrives (multipart, remote URL or data URI). Larger uploads are rejected. Upload API request bodies are capped at four thirds of this plus 1 MiB, which leaves room for a file of this size sent as base64. |
| `RATE_LIMIT_MAX` | `120` | Maximum requests per client IP within `RATE_LIMIT_WINDOW_MS`; further requests get a 429. `0` disables rate limiting, which is usually what you want locally: delivery requests count too, so one image-heavy page can use up the default. Requests carrying a valid admin session are exempt — see [Admin UI](#admin-ui). |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) | Length of the rate-limiting window, in milliseconds. |
| `NODE_ENV` | *(unset)* | Set to `production` on anything exposed: the server then refuses to start while any of the three Cloudinary credentials is still on its shipped default. With any other value, or unset, the defaults are accepted with a startup warning. |
| `ALLOW_DEFAULT_CREDENTIALS` | *(unset)* | Set to `1` to accept the shipped default credentials even when `NODE_ENV=production`. |
| `SSRF_ALLOWED_HOSTS` | *(unset)* | Comma-separated hostnames or IPs, matched exactly, that remote-URL uploads may fetch from even though they are private or loopback addresses (for example `localhost,127.0.0.1`). See [Security](#security). |
| `ADMIN_USERNAME` | *(unset)* | Username for the optional [admin UI](#admin-ui). The UI is only enabled when this **and** `ADMIN_PASSWORD` are set and non-empty; otherwise no `/admin` route is registered at all. |
| `ADMIN_PASSWORD` | *(unset)* | Password for the admin UI. Required together with `ADMIN_USERNAME` — either one alone leaves the UI disabled. |
| `ADMIN_JWT_SECRET` | *(unset)* | HMAC secret used to sign admin session tokens. When unset, a random secret is generated at boot (logged as a warning) and existing admin sessions stop working after a restart. Set it to a long random string to keep sessions across restarts. |

Set the cloud name / key / secret to the **same values your application is configured with** — the clone verifies signatures exactly as Cloudinary does, so mismatched credentials mean 401s.

## Pointing an app at the clone

With credentials matching on both sides, the only change needed in the client app is to direct API traffic at the clone. With the Ruby `cloudinary` gem, set the upload prefix, e.g.:

```yaml
# config/cloudinary.yml
development:
  cloud_name: my-dev-cloud
  api_key: '123456789'
  api_secret: abcdef1234567890
  upload_prefix: http://localhost:33000
```

Because upload responses return URLs pointing back at the clone, delivery works automatically for assets whose returned `secure_url` is stored. If the app builds delivery URLs itself, point its delivery host at the clone as well (or set `PUBLIC_BASE_URL` so returned URLs use an address reachable from the browser).

## Falling back to a real cloud

Pointing an app at the clone changes its cloud name, so every delivery URL the app builds from a stored `public_id` names the clone's cloud, including the `public_id`s of images that were uploaded to a real cloud before the switch. Without help those all 404.

`DELIVERY_FALLBACK_URLS` lists where to send them instead:

```sh
DELIVERY_FALLBACK_URLS=https://res.cloudinary.com/my-test-cloud,https://res.cloudinary.com/my-other-cloud
```

When a delivery request names an asset the clone does not hold, it answers `302` to the same path under a fallback base, keeping the transformation segments, the version and the query string. So `/<clone-cloud>/image/upload/c_fill,w_600/v12/logos/a.png` goes to `https://res.cloudinary.com/my-test-cloud/image/upload/c_fill,w_600/v12/logos/a.png`, and the real cloud applies the transformation.

- **One base:** every miss goes there, and the clone makes no request of its own.
- **Several:** every base but the last is probed in order with a `HEAD` of the same path, and the first that answers 2xx wins. The last base is used without probing when none does, so the browser gets that cloud's own 404. A probe that fails or takes more than 5 seconds counts as a miss. The outcome is remembered per path for 10 minutes.

Only delivery is affected, and only requests for the clone's own cloud name. Uploads, tags and destroy never leave the clone, so nothing is ever written to a fallback cloud. Assets the clone holds are served as before. A redirect carries `Cache-Control: no-store`, so an asset uploaded to the clone later is served by the clone.

## Admin UI

An optional, password-protected web UI at `/admin` for looking at what the clone is holding. It lists every stored asset with a thumbnail, public id, format, dimensions, size, tags and creation date; the name, size and date columns are click-to-sort; there is a text filter over public ids and tags; and each row has a two-step (click, then confirm) delete that removes the metadata row *and* the stored bytes via the same code path as the signed `destroy` API.

It is a read-and-delete view over the existing store — there is no upload or edit function, and it adds no separate storage of its own.

### Shareable views

The table's state lives in the query string, so any view is reproducible by URL — bookmark it, share it, or reload without losing your place:

| Parameter | Values | Default |
| --- | --- | --- |
| `q` | Free text matched against public ids and tags | *(none)* |
| `sort` | `name`, `size`, `date` | `date` |
| `order` | `asc`, `desc` | `desc` |
| `per` | `50`, `100`, `250`, `500`, `1000`, `2500`, `5000` | `50` |
| `page` | 1-based page number | `1` |

For example, `/admin?q=gallery&sort=size&order=desc&per=250&page=2`. Parameters are omitted from the URL while they hold their default, so an untouched view stays a plain `/admin`. Anything unrecognised — a misspelled sort key, a page size that isn't offered, a negative page — falls back to the default rather than being passed to the server.

Rows per page is also a control in the footer. The larger sizes are offered deliberately, but note that a page of 5000 renders 5000 rows and requests 5000 thumbnails; images load lazily, so this is usually survivable, but it is your browser's memory being spent.

### Bulk deletion

Each row has a checkbox, and the header checkbox selects everything on the current page. Once anything is selected a toolbar appears with the count and a two-step **Delete selected**.

Selecting a whole page also offers to escalate: *"Select all N matching…"* extends the selection to every asset matching the current filter, **including rows on pages you have not opened**. So filtering for `apple`, ticking the page, then taking the escalation link and deleting will remove every `apple` match across all pages. With an empty filter that means the entire store, so the toolbar spells out what will happen before you confirm.

The escalated form is resolved server-side from the filter rather than by sending every id from the browser, so it costs the same whether it matches ten assets or fifty thousand. Deletion runs in bounded batches (500 per request) and the button reports progress as it drains; changing the filter clears the selection, since the filter is what defines the set.

### Enabling it

The UI is **disabled by default**. It is only mounted when both credentials are present:

```sh
ADMIN_USERNAME=admin ADMIN_PASSWORD='a-strong-password' bun run start
```

With either variable missing or empty the admin router is never registered, so `/admin` and `/admin/api/*` 404 exactly like any other unknown path.

Before running from source (not needed for the Docker image, which builds it during `docker build`), build the browser bundle once:

```sh
bun run build:web    # bundles web/ -> web/dist with Bun's bundler
```

If the bundle is missing, `/admin` serves a short page telling you to run that command rather than a blank screen.

### Sessions

Sign-in posts the credentials to `/admin/api/login`, which compares both username and password in constant time and returns an HS256 JWT valid for 8 hours. The browser keeps it in `localStorage` and sends it as `Authorization: Bearer …`; every `/admin/api/*` endpoint except login rejects requests without a valid token.

Tokens are signed with `ADMIN_JWT_SECRET`. If that is unset, a random secret is generated at boot — tokens are still unforgeable, but every restart invalidates outstanding sessions (the server logs a warning saying so). There is deliberately no built-in default secret.

### Previews

Only inert raster images (JPEG, PNG, GIF, WebP, AVIF, BMP) are shown as thumbnails. Everything else — SVG, PDF, video, `raw` — is sent by the delivery route with `Content-Disposition: attachment` under a sandboxing CSP (see [Security](#security)), so it would download rather than render; those rows show a format placeholder instead of a broken image.

### Security notes

Enabling the admin UI puts asset listing **and deletion** behind nothing but a username and password, so:

- Serve it over TLS, behind a reverse proxy, and/or restrict it to a trusted network. The password crosses the wire in the clear over plain HTTP.
- Use a real password. There is per-IP rate limiting (`RATE_LIMIT_MAX`) in front of login, but that is not a substitute for a strong secret.
- **Signed-in admins bypass the rate limiter.** One page of the asset table issues an API call plus a thumbnail request per row, which would otherwise exhaust a limit sized for anonymous callers within a couple of pages. Because a thumbnail is a plain `<img>` request that cannot carry an `Authorization` header, logging in also sets an `httpOnly`, `SameSite=Strict` session cookie so those requests are recognisable. That cookie is **only** consulted by the rate limiter — every admin API endpoint still requires the bearer token, which is what keeps the API immune to cross-site requests. The exemption verifies the token's signature, so an invented header or cookie value buys nothing. Login itself stays rate-limited.
- Set `ADMIN_JWT_SECRET` to a long random value on anything long-lived, and treat it like a password — anyone holding it can mint admin sessions.
- Leave it disabled unless you want it. That is the default, and it is the safest configuration.

## Development

```sh
bun test             # run the test suite (signature, upload, tags, admin)
bun run typecheck    # tsc --noEmit, for the server and (separately) web/
bun run build:web    # bundle the admin UI into web/dist
```

The code is a small [Hono](https://hono.dev) app: routes live in [src/routes/](src/routes/), with signature verification in [src/signature.ts](src/signature.ts) and persistence in [src/store.ts](src/store.ts). The admin UI's React sources live in [web/](web/) and are bundled with Bun's own bundler — no Vite/webpack, no CDN assets, nothing loaded off-origin.

## Security

This server is built for local development and trusted-network use. It can be exposed more widely, but only after hardening. The intended security posture is:

- **Set your own credentials.** Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` to values of your own. The shipped defaults are public, so anyone can forge signatures with them; they exist only for local-dev convenience. Run exposed instances with `NODE_ENV=production`, which makes the server refuse to start while any default is still in place — see [Configuration](#configuration).
- **Delivery is unauthenticated.** Anyone who has an asset URL can fetch it — there is no access control on delivery. Do not store sensitive or private content here.
- **Treat uploaded content as untrusted.** Uploaded bytes are served back to browsers. The server forces risky types (e.g. SVG) to download rather than render inline, and sends anti-sniffing and Content-Security-Policy headers, but you should still treat anything uploaded as potentially hostile.
- **Upload size limits and rate limiting.** Uploads are capped at `MAX_UPLOAD_BYTES`, and there is basic per-IP rate limiting via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` to blunt abuse. The client IP is taken from `CF-Connecting-IP` or `X-Forwarded-For` when present, and from the connection otherwise. Those headers are trusted as sent, so an exposed instance needs a reverse proxy that sets them itself; without one a caller can dodge the limiter by inventing a new address per request. See [Configuration](#configuration).
- **SSRF protection on remote-URL uploads.** Passing an `http(s)://` URL as the `file` param fetches it server-side, but requests to private, internal, loopback, link-local, and cloud-metadata addresses are blocked to prevent server-side request forgery. To upload from a URL on your own machine or network during development, list the host in `SSRF_ALLOWED_HOSTS`.
- **Unsigned uploads are accepted by default.** Any `upload_preset` value is accepted as an unsigned upload. On an exposed instance set `REQUIRE_SIGNED_UPLOADS=1` — see [Exposed instances](#exposed-instances).
- **The admin UI is opt-in.** `/admin` does not exist unless `ADMIN_USERNAME` and `ADMIN_PASSWORD` are both set. Enabling it exposes asset listing and deletion behind a single username/password, so only do so behind TLS and a trusted network — see [Admin UI](#admin-ui).
- **Run behind a reverse proxy.** For any non-trivial exposure, put the clone behind a reverse proxy that terminates TLS, restrict network exposure, and set strong credentials.

### Exposed instances

To run the clone somewhere browsers on other machines can reach it, for example as the media backend of a shared test environment:

- Set `NODE_ENV=production` and your own `CLOUDINARY_*` credentials, so the server cannot start on the shipped defaults.
- Set `REQUIRE_SIGNED_UPLOADS=1`. Uploads then need a valid signature and a `timestamp` within one hour of now (seconds or milliseconds are both accepted), and unsigned `upload_preset` uploads are refused.
- Set `CORS_ORIGINS` to the exact origins of the applications whose pages upload straight from the browser.
- Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin, so returned asset URLs work from those browsers.
- Leave `ADMIN_USERNAME` and `ADMIN_PASSWORD` unset unless you need the admin UI.

Authentication failures are logged with the reason and client IP, never the API key that was supplied.

## Limitations

- **No transformations.** Resize/crop/quality/format segments in delivery URLs are parsed but ignored; the original bytes are always returned.
- **Delivery is unauthenticated.** `private` and `authenticated` delivery types are accepted as path segments but behave like `upload` — anyone with the URL gets the asset. Do not expose this server publicly with sensitive content.
- **No Admin API** (`/v1_1/.../resources`, search, etc.) — only upload, destroy, and tags. (The optional [admin UI](#admin-ui) has its own private `/admin/api` endpoints; they are not Cloudinary-compatible.)
- Upload presets are not defined anywhere; any `upload_preset` value is accepted as an unsigned upload, unless `REQUIRE_SIGNED_UPLOADS=1`.
- A delivery miss is a 404 unless `DELIVERY_FALLBACK_URLS` is set, in which case it is redirected (see [Falling back to a real cloud](#falling-back-to-a-real-cloud)); fallback assets are whatever the real cloud serves.
- Delivery responses are sent with `Cache-Control: no-store`, and version numbers in URLs are not checked — a re-upload to the same `public_id` replaces the asset.
- Some response fields (`asset_id`, `etag`, `version_id`) are random values, not content-derived.

## License

[MIT](LICENSE).
