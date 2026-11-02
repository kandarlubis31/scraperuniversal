const express = require('express')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const cheerio = require('cheerio')

puppeteer.use(StealthPlugin())

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CONCURRENCY: parseInt(process.env.CONCURRENCY) || 3,
    TIMEOUT: parseInt(process.env.TIMEOUT) || 45000,
    RETRY_ATTEMPTS: parseInt(process.env.RETRY_ATTEMPTS) || 2,
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 1500,
    MAX_SCROLL: parseInt(process.env.MAX_SCROLL) || 8000,
    RATE_LIMIT_WINDOW: 60 * 1000,   // 1 minute
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 20,
    // Cross-platform Chrome path
    CHROME_PATH: process.env.CHROME_PATH || (
        process.platform === 'win32'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : process.platform === 'darwin'
                ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                : '/usr/bin/google-chrome-stable'
    )
}

// ─────────────────────────────────────────
// BLOCKED PRIVATE / INTERNAL IP RANGES (SSRF protection)
// ─────────────────────────────────────────
const BLOCKED_PATTERNS = [
    /^https?:\/\/localhost/i,
    /^https?:\/\/127\./,
    /^https?:\/\/0\.0\.0\.0/,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
    /^https?:\/\/192\.168\./,
    /^https?:\/\/169\.254\./,    // link-local
    /^https?:\/\/::1/,           // IPv6 loopback
    /^https?:\/\/\[fc/i,         // IPv6 private
    /^file:\/\//i
]

function validateUrl(url) {
    if (!url || typeof url !== 'string') return { valid: false, reason: 'URL tidak boleh kosong' }
    let parsed
    try { parsed = new URL(url) } catch { return { valid: false, reason: 'Format URL tidak valid' } }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { valid: false, reason: 'Hanya protokol http/https yang diizinkan' }
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(url)) return { valid: false, reason: 'URL mengarah ke jaringan internal (diblokir)' }
    }
    return { valid: true }
}

// ─────────────────────────────────────────
// RATE LIMITER (per IP, in-memory)
// ─────────────────────────────────────────
const rateLimitMap = new Map()

function checkRateLimit(ip) {
    const now = Date.now()
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + CONFIG.RATE_LIMIT_WINDOW }
    if (now > entry.resetAt) {
        entry.count = 0
        entry.resetAt = now + CONFIG.RATE_LIMIT_WINDOW
    }
    entry.count++
    rateLimitMap.set(ip, entry)
    return entry.count <= CONFIG.RATE_LIMIT_MAX
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip)
    }
}, 5 * 60 * 1000)

// ─────────────────────────────────────────
// JOB QUEUE (concurrency limiter)
// ─────────────────────────────────────────
class JobQueue {
    constructor(limit) {
        this.limit = limit
        this.active = 0
        this.queue = []
        this.stats = { completed: 0, failed: 0, queued: 0 }
    }

    async add(task) {
        this.stats.queued++
        if (this.active >= this.limit) {
            await new Promise(resolve => this.queue.push(resolve))
        }
        this.active++
        try {
            const result = await task()
            this.stats.completed++
            return result
        } catch (err) {
            this.stats.failed++
            throw err
        } finally {
            this.active--
            this.stats.queued = Math.max(0, this.stats.queued - 1)
            if (this.queue.length > 0) {
                const next = this.queue.shift()
                next()
            }
        }
    }

    getStats() {
        return {
            active: this.active,
            waiting: this.queue.length,
            completed: this.stats.completed,
            failed: this.stats.failed
        }
    }
}

const scrapeQueue = new JobQueue(CONFIG.CONCURRENCY)

// ─────────────────────────────────────────
// BROWSER MANAGER
// ─────────────────────────────────────────
let browser = null
let browserStatus = 'initializing'  // initializing | ready | restarting | error
let restartTimeout = null

async function initBrowser() {
    if (browserStatus === 'restarting') return
    browserStatus = 'restarting'

    try {
        if (browser) {
            await browser.close().catch(() => {})
            browser = null
        }

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--mute-audio',
            '--window-size=1366,768',
            '--js-flags=--max-old-space-size=512',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows'
        ]

        browser = await puppeteer.launch({
            headless: true,
            executablePath: CONFIG.CHROME_PATH,
            args: launchArgs
        })

        browser.on('disconnected', () => {
            console.warn('[Browser] Disconnected, scheduling restart...')
            browserStatus = 'error'
            browser = null
            if (restartTimeout) clearTimeout(restartTimeout)
            restartTimeout = setTimeout(() => initBrowser(), 2000)
        })

        browserStatus = 'ready'
        console.log('[Browser] Ready')
    } catch (err) {
        browserStatus = 'error'
        console.error('[Browser] Failed to launch:', err.message)
        // Retry after 5s
        if (restartTimeout) clearTimeout(restartTimeout)
        restartTimeout = setTimeout(() => initBrowser(), 5000)
    }
}

async function waitForBrowser(maxWait = 30000) {
    const start = Date.now()
    while (browserStatus !== 'ready' || !browser) {
        if (Date.now() - start > maxWait) {
            throw new Error('Browser tidak siap setelah menunggu 30 detik')
        }
        await new Promise(r => setTimeout(r, 500))
    }
}

// ─────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────
async function withRetry(fn, attempts = CONFIG.RETRY_ATTEMPTS, delay = CONFIG.RETRY_DELAY) {
    let lastErr
    for (let i = 0; i <= attempts; i++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (i < attempts) {
                console.warn(`[Retry] Attempt ${i + 1}/${attempts} failed: ${err.message}`)
                await new Promise(r => setTimeout(r, delay * (i + 1)))
            }
        }
    }
    throw lastErr
}

// ─────────────────────────────────────────
// CORE SCRAPER
// ─────────────────────────────────────────
async function scrapeUniversal(targetUrl) {
    return scrapeQueue.add(() =>
        withRetry(async () => {
            await waitForBrowser()
            const page = await browser.newPage()

            // Set realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

            // Extra headers to appear more human
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            })

            // Block unnecessary resources
            await page.setRequestInterception(true)
            page.on('request', req => {
                const blocked = ['image', 'stylesheet', 'font', 'media', 'websocket']
                if (blocked.includes(req.resourceType())) {
                    req.abort().catch(() => {})
                } else {
                    req.continue().catch(() => {})
                }
            })

            try {
                const response = await page.goto(targetUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: CONFIG.TIMEOUT
                })

                const statusCode = response ? response.status() : null

                // Graceful scroll with bounded height
                await page.evaluate(async (maxScroll) => {
                    await new Promise(resolve => {
                        let scrolled = 0
                        const timer = setInterval(() => {
                            window.scrollBy(0, 400)
                            scrolled += 400
                            if (scrolled >= document.body.scrollHeight || scrolled >= maxScroll) {
                                clearInterval(timer)
                                resolve()
                            }
                        }, 120)
                        // Safety timeout
                        setTimeout(() => { clearInterval(timer); resolve() }, 5000)
                    })
                }, CONFIG.MAX_SCROLL)

                const html = await page.content()
                const $ = cheerio.load(html)

                // ── Meta
                const title = $('title').text().trim()
                    || $('meta[property="og:title"]').attr('content')
                    || $('meta[name="twitter:title"]').attr('content')
                    || ''

                const description = $('meta[name="description"]').attr('content')
                    || $('meta[property="og:description"]').attr('content')
                    || $('meta[name="twitter:description"]').attr('content')
                    || ''

                const image = $('meta[property="og:image"]').attr('content')
                    || $('meta[name="twitter:image"]').attr('content')
                    || ''

                const favicon = $('link[rel="icon"]').attr('href')
                    || $('link[rel="shortcut icon"]').attr('href')
                    || '/favicon.ico'

                const canonical = $('link[rel="canonical"]').attr('href') || targetUrl
                const lang = $('html').attr('lang') || ''
                const keywords = $('meta[name="keywords"]').attr('content') || ''
                const author = $('meta[name="author"]').attr('content') || ''
                const robots = $('meta[name="robots"]').attr('content') || ''

                // ── Links
                const links = []
                const seenLinks = new Set()
                $('a[href]').each((_, el) => {
                    const href = ($(el).attr('href') || '').trim()
                    const text = $(el).text().trim()
                    const rel = $(el).attr('rel') || ''
                    const isExternal = href.startsWith('http://') || href.startsWith('https://')
                    if (isExternal && !seenLinks.has(href)) {
                        seenLinks.add(href)
                        links.push({ text: text.slice(0, 200), href, rel })
                    }
                })

                // ── Headings
                const headings = []
                $('h1, h2, h3, h4').each((_, el) => {
                    const tag = el.tagName.toLowerCase()
                    const text = $(el).text().trim()
                    if (text) headings.push({ tag, text: text.slice(0, 300) })
                })

                // ── Paragraphs (meaningful only)
                const paragraphs = []
                $('p').each((_, el) => {
                    const text = $(el).text().trim()
                    if (text.length > 40) paragraphs.push(text.slice(0, 1000))
                })

                // ── Images
                const images = []
                const seenImgSrc = new Set()
                $('img[src]').each((_, el) => {
                    const src = ($(el).attr('src') || '').trim()
                    const alt = $(el).attr('alt') || ''
                    if (src && (src.startsWith('http') || src.startsWith('//')) && !seenImgSrc.has(src)) {
                        seenImgSrc.add(src)
                        images.push({ src, alt: alt.slice(0, 200) })
                    }
                })

                // ── Tables
                const tables = []
                $('table').each((_, tableEl) => {
                    const rows = []
                    $(tableEl).find('tr').each((_, rowEl) => {
                        const cells = []
                        $(rowEl).find('th, td').each((_, cellEl) => {
                            cells.push($(cellEl).text().trim().slice(0, 300))
                        })
                        if (cells.length) rows.push(cells)
                    })
                    if (rows.length) tables.push(rows)
                })

                // ── Structured Data (JSON-LD)
                const jsonLd = []
                $('script[type="application/ld+json"]').each((_, el) => {
                    try {
                        const parsed = JSON.parse($(el).html())
                        jsonLd.push(parsed)
                    } catch {}
                })

                // ── Open Graph full object
                const openGraph = {}
                $('meta[property^="og:"]').each((_, el) => {
                    const prop = ($(el).attr('property') || '').replace('og:', '')
                    openGraph[prop] = $(el).attr('content') || ''
                })

                return {
                    url: targetUrl,
                    canonical,
                    statusCode,
                    scrapedAt: new Date().toISOString(),
                    meta: { title, description, image, favicon, lang, keywords, author, robots },
                    openGraph,
                    content: { headings, paragraphs, images: images.slice(0, 50), tables },
                    links: links.slice(0, 200),
                    structuredData: jsonLd
                }
            } finally {
                if (!page.isClosed()) await page.close().catch(() => {})
            }
        })
    )
}

// ─────────────────────────────────────────
// FRONTEND HTML
// ─────────────────────────────────────────
const htmlFrontend = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebScraper Pro</title>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg:         #080C10;
            --surface:    #0E1520;
            --surface2:   #141D2B;
            --border:     #1E2D42;
            --border-hi:  #2A4060;
            --accent:     #00C896;
            --accent-dim: rgba(0,200,150,0.12);
            --accent2:    #0098FF;
            --warn:       #FF6B35;
            --text:       #D6E4F5;
            --text-dim:   #6B8BAD;
            --text-muted: #3A5070;
            --radius:     10px;
            --mono:       'JetBrains Mono', monospace;
            --sans:       'Syne', sans-serif;
        }

        body {
            background: var(--bg);
            color: var(--text);
            font-family: var(--sans);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 16px 80px;
        }

        /* ── Noise texture overlay */
        body::before {
            content: '';
            position: fixed; inset: 0;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
            pointer-events: none; z-index: 0;
        }

        .wrapper { position: relative; z-index: 1; width: 100%; max-width: 860px; }

        /* ── Header */
        header {
            display: flex; align-items: center; gap: 14px;
            margin-bottom: 40px;
        }
        .logo {
            width: 38px; height: 38px;
            border: 2px solid var(--accent);
            border-radius: 8px;
            display: grid; place-items: center;
            font-size: 18px;
        }
        .brand { display: flex; flex-direction: column; }
        .brand-name { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; color: #fff; }
        .brand-sub  { font-size: 11px; font-family: var(--mono); color: var(--text-dim); letter-spacing: 1.5px; text-transform: uppercase; }
        .status-dot {
            margin-left: auto;
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; font-family: var(--mono); color: var(--text-dim);
        }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
        .dot.ready { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 2s infinite; }
        .dot.error { background: var(--warn); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

        /* ── Input card */
        .input-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 20px;
            margin-bottom: 16px;
        }
        .url-row { display: flex; gap: 10px; }
        .url-wrap {
            flex: 1; display: flex; align-items: center;
            background: var(--surface2); border: 1px solid var(--border);
            border-radius: 8px; padding: 0 14px; gap: 8px;
            transition: border-color .2s;
        }
        .url-wrap:focus-within { border-color: var(--accent); }
        .url-wrap span { font-family: var(--mono); font-size: 12px; color: var(--text-muted); white-space: nowrap; }
        input[type="url"] {
            flex: 1; background: none; border: none; outline: none;
            color: var(--text); font-family: var(--mono); font-size: 13px;
            padding: 13px 0;
        }
        input[type="url"]::placeholder { color: var(--text-muted); }

        .btn {
            padding: 0 22px; border: none; border-radius: 8px;
            font-family: var(--sans); font-weight: 700; font-size: 14px;
            cursor: pointer; transition: all .2s; white-space: nowrap;
        }
        .btn-primary {
            background: var(--accent); color: #000;
            height: 46px;
        }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
        .btn-primary:disabled { background: var(--surface2); color: var(--text-muted); cursor: not-allowed; }
        .btn-sm {
            background: var(--surface2); color: var(--text-dim);
            border: 1px solid var(--border); padding: 6px 12px;
            font-size: 11px; border-radius: 6px; font-family: var(--mono);
        }
        .btn-sm:hover { border-color: var(--border-hi); color: var(--text); }

        /* Options row */
        .options-row {
            display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;
        }
        .opt-chip {
            display: flex; align-items: center; gap: 6px;
            background: var(--surface2); border: 1px solid var(--border);
            border-radius: 20px; padding: 5px 12px;
            font-size: 12px; color: var(--text-dim);
            cursor: pointer; transition: all .15s;
            user-select: none;
        }
        .opt-chip input { display: none; }
        .opt-chip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
        .opt-chip:hover { border-color: var(--border-hi); color: var(--text); }

        /* ── Progress */
        .progress-wrap { margin-bottom: 16px; display: none; }
        .progress-label {
            display: flex; justify-content: space-between; align-items: center;
            font-family: var(--mono); font-size: 11px; color: var(--text-dim);
            margin-bottom: 6px;
        }
        .progress-bar-bg {
            height: 3px; background: var(--surface2); border-radius: 2px; overflow: hidden;
        }
        .progress-bar-fill {
            height: 100%; width: 0%; background: var(--accent);
            border-radius: 2px; transition: width .4s ease;
        }
        .progress-log {
            font-family: var(--mono); font-size: 11px; color: var(--text-muted);
            margin-top: 6px; min-height: 16px;
        }

        /* ── Stats row */
        .stats-row {
            display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
            margin-bottom: 16px; display: none;
        }
        .stat-card {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 8px; padding: 12px 14px;
        }
        .stat-num { font-size: 22px; font-weight: 800; color: #fff; }
        .stat-label { font-size: 10px; font-family: var(--mono); color: var(--text-muted); letter-spacing: .5px; margin-top: 2px; }

        /* ── Tabs */
        .tabs-wrap { display: none; }
        .tabs {
            display: flex; gap: 2px;
            background: var(--surface); border: 1px solid var(--border);
            border-bottom: none; border-radius: var(--radius) var(--radius) 0 0;
            padding: 6px 6px 0;
            overflow-x: auto;
        }
        .tab {
            padding: 8px 16px; border-radius: 6px 6px 0 0;
            font-size: 12px; font-family: var(--mono); cursor: pointer;
            color: var(--text-dim); border: 1px solid transparent;
            border-bottom: none; white-space: nowrap; transition: all .15s;
        }
        .tab.active {
            background: var(--bg); color: var(--accent);
            border-color: var(--border);
        }
        .tab:not(.active):hover { color: var(--text); }

        .tab-pane { display: none; }
        .tab-pane.active { display: block; }

        /* ── Result box */
        .result-box {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 0 0 var(--radius) var(--radius);
            padding: 0;
        }
        .result-toolbar {
            display: flex; justify-content: flex-end; gap: 6px;
            padding: 10px 14px; border-bottom: 1px solid var(--border);
        }
        pre {
            padding: 16px 18px; overflow-x: auto;
            white-space: pre-wrap; word-break: break-all;
            font-family: var(--mono); font-size: 12px; line-height: 1.7;
            color: #8BBFDF; max-height: 480px; overflow-y: auto;
        }
        pre .k { color: #9ECBFF; }  /* keys */
        pre .s { color: #9DEBA8; }  /* strings */
        pre .n { color: #FFD599; }  /* numbers */
        pre .b { color: var(--warn); } /* booleans/null */

        /* ── Rendered preview */
        .preview-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
            padding: 16px 18px;
        }
        .preview-section {
            background: var(--surface2); border: 1px solid var(--border);
            border-radius: 8px; padding: 14px;
        }
        .preview-section h4 {
            font-size: 10px; font-family: var(--mono); color: var(--text-muted);
            letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px;
        }
        .meta-row { display: flex; flex-direction: column; gap: 6px; }
        .meta-item label { font-size: 10px; color: var(--text-muted); font-family: var(--mono); }
        .meta-item p { font-size: 13px; color: var(--text); margin-top: 1px; word-break: break-word; }
        .tag { display: inline-block; background: var(--accent-dim); color: var(--accent); border: 1px solid rgba(0,200,150,.2); border-radius: 4px; padding: 2px 7px; font-size: 11px; font-family: var(--mono); margin: 2px 2px 0 0; }
        .link-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
        .link-item { font-size: 11px; font-family: var(--mono); color: var(--accent2); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
        .link-item:hover { text-decoration: underline; }

        /* ── Error / empty states */
        .empty-state {
            padding: 60px 20px; text-align: center;
            font-family: var(--mono); color: var(--text-muted); font-size: 13px;
        }
        .empty-state .icon { font-size: 40px; margin-bottom: 10px; }
        .error-banner {
            background: rgba(255,107,53,.08); border: 1px solid rgba(255,107,53,.3);
            border-radius: var(--radius); padding: 14px 18px;
            font-family: var(--mono); font-size: 12px; color: var(--warn);
            margin-bottom: 16px; display: none;
        }
        .error-banner.show { display: block; }

        /* ── Queue status */
        .queue-badge {
            font-family: var(--mono); font-size: 10px; color: var(--text-muted);
            padding: 4px 10px; background: var(--surface2); border: 1px solid var(--border);
            border-radius: 20px; margin-left: 8px;
        }

        @media (max-width: 600px) {
            .preview-grid { grid-template-columns: 1fr; }
            .stats-row { grid-template-columns: 1fr 1fr; }
            .url-row { flex-direction: column; }
        }
    </style>
</head>
<body>
<div class="wrapper">

    <!-- Header -->
    <header>
        <div class="logo">🔎</div>
        <div class="brand">
            <span class="brand-name">WebScraper<span style="color:var(--accent)">Pro</span></span>
            <span class="brand-sub">Universal JSON Extractor</span>
        </div>
        <div class="status-dot">
            <div class="dot" id="statusDot"></div>
            <span id="statusText">Checking...</span>
        </div>
    </header>

    <!-- Input -->
    <div class="input-card">
        <div class="url-row">
            <div class="url-wrap">
                <span>url://</span>
                <input type="url" id="urlInput" placeholder="masukkan URL target..." autocomplete="off" onkeydown="if(event.key==='Enter')startScrape()">
            </div>
            <button class="btn btn-primary" id="scrapeBtn" onclick="startScrape()">Scrape →</button>
        </div>
        <div class="options-row" id="optionsRow">
            <label class="opt-chip active" id="opt-meta"><input type="checkbox" checked> ◆ Meta</label>
            <label class="opt-chip active" id="opt-content"><input type="checkbox" checked> ◆ Content</label>
            <label class="opt-chip active" id="opt-links"><input type="checkbox" checked> ◆ Links</label>
            <label class="opt-chip active" id="opt-images"><input type="checkbox" checked> ◆ Images</label>
            <label class="opt-chip active" id="opt-tables"><input type="checkbox" checked> ◆ Tables</label>
            <label class="opt-chip active" id="opt-structured"><input type="checkbox" checked> ◆ JSON-LD</label>
        </div>
    </div>

    <!-- Error banner -->
    <div class="error-banner" id="errorBanner"></div>

    <!-- Progress -->
    <div class="progress-wrap" id="progressWrap">
        <div class="progress-label">
            <span id="progressLabel">Menghubungi server...</span>
            <span id="progressPct">0%</span>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
        <div class="progress-log" id="progressLog"></div>
    </div>

    <!-- Stats -->
    <div class="stats-row" id="statsRow">
        <div class="stat-card"><div class="stat-num" id="s-headings">-</div><div class="stat-label">Headings</div></div>
        <div class="stat-card"><div class="stat-num" id="s-paragraphs">-</div><div class="stat-label">Paragraphs</div></div>
        <div class="stat-card"><div class="stat-num" id="s-links">-</div><div class="stat-label">Links</div></div>
        <div class="stat-card"><div class="stat-num" id="s-images">-</div><div class="stat-label">Images</div></div>
    </div>

    <!-- Tabs + Results -->
    <div class="tabs-wrap" id="tabsWrap">
        <div class="tabs">
            <div class="tab active" onclick="switchTab('preview')">👁 Preview</div>
            <div class="tab" onclick="switchTab('json')">{ } JSON</div>
            <div class="tab" onclick="switchTab('links')">🔗 Links</div>
        </div>
        <div class="result-box">
            <!-- Preview Tab -->
            <div class="tab-pane active" id="tab-preview">
                <div class="preview-grid" id="previewGrid"></div>
            </div>
            <!-- JSON Tab -->
            <div class="tab-pane" id="tab-json">
                <div class="result-toolbar">
                    <button class="btn btn-sm" onclick="copyJSON()">Copy JSON</button>
                    <button class="btn btn-sm" onclick="downloadJSON()">↓ Download</button>
                </div>
                <pre id="jsonOutput"><div class="empty-state"><div class="icon">◌</div>Belum ada data</div></pre>
            </div>
            <!-- Links Tab -->
            <div class="tab-pane" id="tab-links">
                <div class="result-toolbar">
                    <button class="btn btn-sm" onclick="downloadLinks()">↓ Export CSV</button>
                </div>
                <div style="padding:14px 18px;" id="linksView"></div>
            </div>
        </div>
    </div>

</div>

<script>
    let currentData = null
    let activeTab = 'preview'
    const STEPS = [
        [10, 'Menginisialisasi browser...'],
        [25, 'Membuka halaman target...'],
        [50, 'Memuat konten halaman...'],
        [70, 'Melakukan scroll otomatis...'],
        [85, 'Mengekstrak data...'],
        [95, 'Memproses hasil...'],
    ]
    let progressTimer = null

    // ── Status polling
    async function pollStatus() {
        try {
            const r = await fetch('/api/status')
            const d = await r.json()
            const dot = document.getElementById('statusDot')
            const txt = document.getElementById('statusText')
            if (d.browserStatus === 'ready') {
                dot.className = 'dot ready'
                txt.textContent = 'Ready'
            } else if (d.browserStatus === 'initializing' || d.browserStatus === 'restarting') {
                dot.className = 'dot'
                txt.textContent = d.browserStatus + '...'
            } else {
                dot.className = 'dot error'
                txt.textContent = 'Error'
            }
        } catch {}
    }
    pollStatus()
    setInterval(pollStatus, 5000)

    // ── Options chip toggle
    document.querySelectorAll('.opt-chip').forEach(chip => {
        chip.addEventListener('click', () => chip.classList.toggle('active'))
    })

    // ── Progress simulation
    function startProgress() {
        let step = 0
        document.getElementById('progressWrap').style.display = 'block'
        progressTimer = setInterval(() => {
            if (step >= STEPS.length) return
            const [pct, label] = STEPS[step++]
            document.getElementById('progressFill').style.width = pct + '%'
            document.getElementById('progressPct').textContent = pct + '%'
            document.getElementById('progressLabel').textContent = label
            document.getElementById('progressLog').textContent = '→ ' + label
        }, 1800)
    }

    function stopProgress(success) {
        clearInterval(progressTimer)
        document.getElementById('progressFill').style.width = success ? '100%' : '0%'
        document.getElementById('progressPct').textContent = success ? '100%' : '—'
        document.getElementById('progressLabel').textContent = success ? 'Selesai!' : 'Gagal'
        setTimeout(() => {
            document.getElementById('progressWrap').style.display = 'none'
        }, 1200)
    }

    // ── Scrape
    async function startScrape() {
        const url = document.getElementById('urlInput').value.trim()
        const btn = document.getElementById('scrapeBtn')
        const errorBanner = document.getElementById('errorBanner')

        errorBanner.className = 'error-banner'
        if (!url) { showError('URL tidak boleh kosong'); return }
        if (!url.startsWith('http')) { showError('URL harus diawali dengan http:// atau https://'); return }

        btn.disabled = true
        btn.textContent = 'Loading...'
        document.getElementById('tabsWrap').style.display = 'none'
        document.getElementById('statsRow').style.display = 'none'
        startProgress()

        try {
            const res = await fetch('/api/scrape?url=' + encodeURIComponent(url))
            const data = await res.json()

            if (!res.ok) {
                stopProgress(false)
                showError(data.error || 'Scraping gagal')
                return
            }

            currentData = data
            stopProgress(true)
            renderResults(data)
        } catch (err) {
            stopProgress(false)
            showError('Network error: ' + err.message)
        } finally {
            btn.disabled = false
            btn.textContent = 'Scrape →'
        }
    }

    function showError(msg) {
        const el = document.getElementById('errorBanner')
        el.textContent = '⚠ ' + msg
        el.className = 'error-banner show'
    }

    // ── Render results
    function renderResults(data) {
        document.getElementById('tabsWrap').style.display = 'block'

        // Stats
        const stats = document.getElementById('statsRow')
        stats.style.display = 'grid'
        document.getElementById('s-headings').textContent = data.content?.headings?.length ?? 0
        document.getElementById('s-paragraphs').textContent = data.content?.paragraphs?.length ?? 0
        document.getElementById('s-links').textContent = data.links?.length ?? 0
        document.getElementById('s-images').textContent = data.content?.images?.length ?? 0

        // JSON tab
        document.getElementById('jsonOutput').innerHTML = syntaxHighlight(JSON.stringify(filterByOptions(data), null, 2))

        // Links tab
        renderLinks(data.links || [])

        // Preview tab
        renderPreview(data)
    }

    function filterByOptions(data) {
        const out = { url: data.url, canonical: data.canonical, statusCode: data.statusCode, scrapedAt: data.scrapedAt }
        if (document.getElementById('opt-meta').classList.contains('active')) out.meta = data.meta
        if (document.getElementById('opt-content').classList.contains('active')) {
            out.content = {
                headings: data.content?.headings,
                paragraphs: data.content?.paragraphs,
                ...(document.getElementById('opt-images').classList.contains('active') ? { images: data.content?.images } : {}),
                ...(document.getElementById('opt-tables').classList.contains('active') ? { tables: data.content?.tables } : {}),
            }
        }
        if (document.getElementById('opt-links').classList.contains('active')) out.links = data.links
        if (document.getElementById('opt-structured').classList.contains('active')) out.structuredData = data.structuredData
        return out
    }

    function renderPreview(data) {
        const grid = document.getElementById('previewGrid')
        const m = data.meta || {}
        grid.innerHTML = \`
            <div class="preview-section" style="grid-column:1/-1">
                <h4>Page Info</h4>
                <div class="meta-row">
                    <div class="meta-item"><label>Title</label><p>\${esc(m.title || '—')}</p></div>
                    <div class="meta-item"><label>Description</label><p>\${esc(m.description?.slice(0,200) || '—')}</p></div>
                    <div class="meta-item"><label>URL → Canonical</label><p style="font-family:var(--mono);font-size:11px;color:var(--accent2)">\${esc(data.canonical || data.url)}</p></div>
                    <div class="meta-item" style="display:flex;gap:12px;flex-wrap:wrap">
                        \${badge('Status', data.statusCode)}
                        \${badge('Lang', m.lang || '?')}
                        \${badge('Links', data.links?.length)}
                        \${badge('Images', data.content?.images?.length)}
                        \${badge('JSON-LD', data.structuredData?.length)}
                    </div>
                </div>
            </div>
            <div class="preview-section">
                <h4>Headings</h4>
                \${(data.content?.headings || []).slice(0,10).map(h => \`<div style="margin:4px 0"><span class="tag">\${h.tag}</span> <span style="font-size:12px">\${esc(h.text.slice(0,80))}</span></div>\`).join('') || '<div style="color:var(--text-muted);font-size:12px">—</div>'}
            </div>
            <div class="preview-section">
                <h4>Meta Details</h4>
                \${Object.entries(m).filter(([k,v])=>v).map(([k,v])=>\`<div class="meta-item"><label>\${k}</label><p style="font-size:11px">\${esc(String(v).slice(0,120))}</p></div>\`).join('')}
            </div>
        \`
    }

    function badge(label, val) {
        return \`<div class="meta-item"><label>\${label}</label><p><span class="tag">\${val ?? '—'}</span></p></div>\`
    }

    function renderLinks(links) {
        const el = document.getElementById('linksView')
        if (!links.length) { el.innerHTML = '<div class="empty-state"><div class="icon">◌</div>Tidak ada link ditemukan</div>'; return }
        el.innerHTML = \`
            <div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-bottom:10px">\${links.length} link ditemukan</div>
            <div class="link-list">
                \${links.map(l=>\`<a class="link-item" href="\${esc(l.href)}" target="_blank" rel="noopener">\${esc(l.text || l.href)}</a>\`).join('')}
            </div>
        \`
    }

    // ── Tabs
    function switchTab(name) {
        activeTab = name
        document.querySelectorAll('.tab').forEach((t,i)=>{
            const names = ['preview','json','links']
            t.classList.toggle('active', names[i] === name)
        })
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
        document.getElementById('tab-' + name).classList.add('active')
    }

    // ── JSON syntax highlight
    function syntaxHighlight(json) {
        return json
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"(\\\\.|[^"\\\\])*"/g, m => \`<span class="s">\${m}</span>\`)
            .replace(/\\b(-?\\d+(\\.\\d+)?)\\b/g, '<span class="n">$1</span>')
            .replace(/\\b(true|false|null)\\b/g, '<span class="b">$1</span>')
    }

    function esc(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    // ── Export
    function copyJSON() {
        if (!currentData) return
        navigator.clipboard.writeText(JSON.stringify(filterByOptions(currentData), null, 2)).then(() => {
            const btn = event.target
            btn.textContent = '✓ Copied!'
            setTimeout(() => btn.textContent = 'Copy JSON', 2000)
        })
    }

    function downloadJSON() {
        if (!currentData) return
        const blob = new Blob([JSON.stringify(filterByOptions(currentData), null, 2)], {type:'application/json'})
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'scrape-result-' + Date.now() + '.json'
        a.click()
    }

    function downloadLinks() {
        if (!currentData?.links?.length) return
        const csv = 'text,href,rel\\n' + currentData.links.map(l =>
            \`"\${(l.text||'').replace(/"/g,'""')}","\${l.href}","\${l.rel||''}"\`
        ).join('\\n')
        const blob = new Blob([csv], {type:'text/csv'})
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'links-' + Date.now() + '.csv'
        a.click()
    }
</script>
</body>
</html>`

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────
app.get('/', (_, res) => res.send(htmlFrontend))

app.get('/api/status', (_, res) => {
    res.json({
        browserStatus,
        queue: scrapeQueue.getStats(),
        uptime: process.uptime()
    })
})

app.get('/api/scrape', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress

    // Rate limit
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' })
    }

    const targetUrl = (req.query.url || '').trim()
    const { valid, reason } = validateUrl(targetUrl)
    if (!valid) return res.status(400).json({ error: reason })

    try {
        const data = await scrapeUniversal(targetUrl)
        res.json(data)
    } catch (err) {
        console.error('[Scrape Error]', targetUrl, err.message)
        res.status(500).json({ error: err.message })
    }
})

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = CONFIG.PORT
const server = app.listen(PORT, async () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`)
    await initBrowser()
})

process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...')
    if (browser) await browser.close().catch(() => {})
    server.close(() => process.exit(0))
})

process.on('SIGTERM', async () => {
    if (browser) await browser.close().catch(() => {})
    server.close(() => process.exit(0))
})