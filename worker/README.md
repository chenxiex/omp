# OMP Media Proxy Worker

English | [中文](README_CN.md)

This optional Worker verifies browser-generated HMAC media URLs and streams
`GET`, `HEAD`, and byte-range requests from a short-lived OneDrive download
URL. It never receives a Microsoft Graph access token.

Cloudflare Workers should only be used for personal, low-traffic experiments.
Cloudflare and OpenList do not recommend using a general Worker as a long-term
or high-volume media delivery service.

## Configure

1. Install dependencies with `npm install` in this directory.
2. Generate and set a strong random proxy key:

   ```sh
   openssl rand -base64 32 | npx wrangler secret put PROXY_ACCESS_KEY
   ```

3. Edit `wrangler.jsonc`:
   - `ALLOWED_ORIGINS` is a comma-separated list of OMP origins. Origins do not
     contain paths; the hosted OMP origin is `https://nini22p.github.io`.
   - `ALLOWED_UPSTREAM_SUFFIXES` is a comma-separated allowlist for Microsoft
     download hosts. `.1drv.com,.sharepoint.com` covers common global OneDrive
     URLs. Add only Microsoft-owned suffixes observed for the cloud you use.
4. Deploy with `npm run deploy`.
5. In OMP settings, enter the deployed Worker origin and the exact
   `PROXY_ACCESS_KEY` value.

OMP stores the access key only in that browser's local settings, while the
Worker stores the same value as a secret. OMP uses it to sign a media URL with
HMAC-SHA256; the key itself is never included in that URL. Keys are not
required to use a particular encoding, but short or reused passwords are
vulnerable to offline guessing if a signed media URL is exposed.

The signed payload contains a reversible Base64URL encoding of the temporary
OneDrive download URL. It can therefore appear in CDN or Worker request logs
for every media request. The sample configuration disables Worker
observability by default. Do not add application logging for keys, signed
media URLs, or decoded upstream URLs.

Changing the account, Worker address, access key, or enable switch clears OMP's
in-memory media source cache. Failed proxy playback is retried with one fresh
Graph download URL and signature, then falls back to a fresh direct Graph
download URL.

## Test

```sh
npm test
```

Run `npm run typecheck` to type-check the Worker and its tests, or run
`npm run check` to run both checks.
