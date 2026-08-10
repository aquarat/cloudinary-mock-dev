# cloudinary-mock-dev

This app came into being after I found I need to run some tests on a large media dataset and a Cloudinary dev account wasn't going to cut it. To make matters worse, in what I feel is a dark pattern, Cloudinary allows you to exceed your quotas on a dev account and then they threaten to delete said dev account shortly thereafter - this is coercive behaviour. They also don't make it easy to clean up the account. This app was far more fun to quickly put together.

Be warned, this app is largely vibe-coded. Some security hardening has been done, but as always, take precautions.
Also note that this app supports a sub-set of Cloudinary functionality - enough to be useful for me for testing. It is intended as a development aid, not a production service.

And now I'll hand over to the AI README...

A small, self-hosted stand-in for [Cloudinary](https://cloudinary.com), intended for local development and testing. It mimics enough of Cloudinary's Upload API and delivery-URL scheme that an application using a Cloudinary SDK (e.g. the Ruby `cloudinary` gem) can be pointed at this server instead of the real service — no code changes, just configuration.

It is **not** a general-purpose Cloudinary replacement: it stores originals and serves them back verbatim. See [Limitations](#limitations).

> **⚠️ This is a development tool.** Do not expose it to the untrusted public internet without the hardening described in [Security](#security) below. It is designed for local development and trusted-network use.

## What it implements

**Upload API** (mimics `api.cloudinary.com/v1_1/...`):

| Endpoint | Notes |
| --- | --- |
| `POST /v1_1/:cloud_name/:resource_type/upload` | `resource_type` may be `image`, `video`, `raw`, or `auto` (detected from content type). Accepts multipart file uploads, remote `http(s)://` URLs, and `data:` URIs as the `file` param. Supports signed uploads (api_key + signature verification) and unsigned uploads via `upload_preset`. Honours `public_id`, `folder`, `type`, `format`, and `tags` params, and returns a Cloudinary-shaped JSON response (`public_id`, `version`, `secure_url`, dimensions, etc.). |
| `POST /v1_1/:cloud_name/:resource_type/destroy` | Signed. Deletes the asset record and its stored bytes. |
| `POST /v1_1/:cloud_name/:resource_type/tags` | Signed. Supports the `add`, `remove`, `replace`, and `remove_all` commands (matches `Cloudinary::Uploader.*_tags`). |
| `GET /health` | Returns `{"status": "ok"}`; used by the Docker healthcheck. |

**Delivery** (mimics `res.cloudinary.com/<cloud_name>/...`):

```
GET /:cloud_name/:resource_type/:type/[transformations/][vN/]:public_id.:format
```

Transformation segments (e.g. `c_fill,w_600`) and version segments (`v1234`) in the path are accepted and ignored — the originally-uploaded bytes are always served, with the correct `Content-Type` for the stored format.

Upload responses build their `url`/`secure_url` against this same server, so an app that stores the returned URL will fetch assets back from the clone.

**Storage:** asset metadata lives in a SQLite database (`assets.sqlite`) and file bytes on disk under `blobs/`, both inside `DATA_DIR`. A structured access log is written to `DATA_DIR/access.log`.

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
| `MAX_UPLOAD_BYTES` | configurable, sensible default (~25 MiB) | Maximum accepted upload size, in bytes. Uploads larger than this are rejected. |
| `RATE_LIMIT_MAX` | configurable, sensible default (~120) | Maximum requests allowed per IP within `RATE_LIMIT_WINDOW_MS` before requests are throttled. |
| `RATE_LIMIT_WINDOW_MS` | configurable, sensible default (~60000, i.e. 1 minute) | Length of the rate-limiting window, in milliseconds. Together with `RATE_LIMIT_MAX` this defaults to roughly 120 requests/minute per IP. |
| `NODE_ENV` | *(unset)* | Set to `development` to allow running with the shipped default credentials. On an exposed instance leave this unset (or `production`) and provide your own credentials — see [Security](#security). |

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

## Development

```sh
bun test             # run the test suite (signature, upload, tags)
bun run typecheck    # tsc --noEmit
```

The code is a small [Hono](https://hono.dev) app: routes live in [src/routes/](src/routes/), with signature verification in [src/signature.ts](src/signature.ts) and persistence in [src/store.ts](src/store.ts).

## Security

This server is built for local development and trusted-network use. It can be exposed more widely, but only after hardening. The intended security posture is:

- **Set your own credentials.** You **must** set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` to non-default values of your own. The server ships with well-known default credentials purely for local-dev convenience; on an exposed instance it will refuse to start with the defaults (or only accept them in an explicit development mode — see `NODE_ENV` in [Configuration](#configuration)). Never rely on the defaults on anything reachable by untrusted clients.
- **Delivery is unauthenticated.** Anyone who has an asset URL can fetch it — there is no access control on delivery. Do not store sensitive or private content here.
- **Treat uploaded content as untrusted.** Uploaded bytes are served back to browsers. The server forces risky types (e.g. SVG) to download rather than render inline, and sends anti-sniffing and Content-Security-Policy headers, but you should still treat anything uploaded as potentially hostile.
- **Upload size limits and rate limiting.** Uploads are capped at `MAX_UPLOAD_BYTES`, and there is basic per-IP rate limiting via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` to blunt abuse. See [Configuration](#configuration).
- **SSRF protection on remote-URL uploads.** Passing an `http(s)://` URL as the `file` param fetches it server-side, but requests to private, internal, loopback, link-local, and cloud-metadata addresses are blocked to prevent server-side request forgery.
- **Unsigned uploads are accepted.** Any `upload_preset` value is accepted as an unsigned upload. On an exposed instance, prefer requiring signed uploads and place the service behind a reverse proxy with additional access controls.
- **Run behind a reverse proxy.** For any non-trivial exposure, put the clone behind a reverse proxy that terminates TLS, restrict network exposure, and set strong credentials.

## Limitations

- **No transformations.** Resize/crop/quality/format segments in delivery URLs are parsed but ignored; the original bytes are always returned.
- **Delivery is unauthenticated.** `private` and `authenticated` delivery types are accepted as path segments but behave like `upload` — anyone with the URL gets the asset. Do not expose this server publicly with sensitive content.
- **No Admin API** (`/v1_1/.../resources`, search, etc.) — only upload, destroy, and tags.
- Upload presets are not defined anywhere; any `upload_preset` value is accepted as an unsigned upload.
- Delivery responses are sent with `Cache-Control: no-store`, and version numbers in URLs are not checked — a re-upload to the same `public_id` replaces the asset.
- Some response fields (`asset_id`, `etag`, `version_id`) are random values, not content-derived.
