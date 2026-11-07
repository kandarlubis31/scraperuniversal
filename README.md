# scraperUniversal

A small self-hosted HTTP service that renders a page in headless Chrome and returns
structured data, so you can scrape sites that only render on the client.

The browser is launched through `puppeteer-extra` with the stealth plugin, which avoids
the most common headless fingerprints. HTML is then parsed with `cheerio`. A static
control panel in `public/` lets you submit a URL and inspect the result.

## Features

- **Headless Chrome rendering** with `puppeteer-extra-plugin-stealth`
- **Job controls** — concurrency, request timeout, retry attempts and retry delay are all configurable
- **Rate limiting** — 20 requests per minute per window by default
- **SSRF protection** — requests to loopback, private ranges (`10/8`, `172.16/12`, `192.168/16`),
  link-local, `.local` and `file://` URLs are rejected before a browser is launched
- **Auto-scroll** — scrolls up to a configurable pixel depth to trigger lazy-loaded content
- **Web UI** — served from `public/`

## Requirements

- Node.js 18+
- Google Chrome installed locally (or point `CHROME_PATH` at a Chromium binary)

## Install

```bash
npm install
```

## Run

```bash
node server.js
```

Then open `http://localhost:3000`.

## Configuration

All settings are environment variables with sane defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `CONCURRENCY` | `3` | Parallel browser jobs |
| `TIMEOUT` | `45000` | Per-request timeout in ms |
| `RETRY_ATTEMPTS` | `2` | Retries before giving up |
| `RETRY_DELAY` | `1500` | Delay between retries in ms |
| `MAX_SCROLL` | `8000` | Maximum scroll depth for lazy content |
| `RATE_LIMIT_MAX` | `20` | Requests allowed per window |
| `CHROME_PATH` | auto-detected | Explicit Chrome/Chromium executable path |

`CHROME_PATH` is auto-detected for Windows, macOS and Linux. Set it if the browser is
installed somewhere unusual.

## Notes

The SSRF blocklist runs before the browser starts. If you add hostnames that resolve to
private addresses, resolve them yourself first — the check works on the URL string, not on
the resolved IP.

Scrape responsibly: this tool exists for pages you are allowed to read. Respect the target
site's terms of service and robots policy.

---

## Bahasa Indonesia

**scraperUniversal** adalah layanan HTTP self-hosted kecil yang merender halaman di Chrome headless lalu mengembalikan data terstruktur, sehingga situs yang hanya dirender di sisi klien tetap bisa diambil datanya.

---

## License

MIT
