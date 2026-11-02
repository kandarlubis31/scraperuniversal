const express = require('express')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const cheerio = require('cheerio')
const path = require('path')

puppeteer.use(StealthPlugin())

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

const CONFIG = {
    PORT: process.env.PORT || 3000,
    CONCURRENCY: parseInt(process.env.CONCURRENCY) || 3,
    TIMEOUT: parseInt(process.env.TIMEOUT) || 45000,
    RETRY_ATTEMPTS: parseInt(process.env.RETRY_ATTEMPTS) || 2,
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 1500,
    MAX_SCROLL: parseInt(process.env.MAX_SCROLL) || 8000,
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 20,
    CHROME_PATH: process.env.CHROME_PATH || (
        process.platform === 'win32'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : process.platform === 'darwin'
                ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                : '/usr/bin/google-chrome-stable'
    )
}

const BLOCKED_PATTERNS = [
    /^https?:\/\/localhost/i,
    /^https?:\/\/127\./,
    /^https?:\/\/0\.0\.0\.0/,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
    /^https?:\/\/192\.168\./,
    /^https?:\/\/169\.254\./,
    /^https?:\/\/::1/,
    /^https?:\/\/\[fc/i,
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

setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip)
    }
}, 5 * 60 * 1000)

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

let browser = null
let browserStatus = 'initializing'
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

async function scrapeUniversal(targetUrl) {
    return scrapeQueue.add(() =>
        withRetry(async () => {
            await waitForBrowser()
            const page = await browser.newPage()

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            })

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
                        setTimeout(() => { clearInterval(timer); resolve() }, 5000)
                    })
                }, CONFIG.MAX_SCROLL)

                const html = await page.content()
                const $ = cheerio.load(html)

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

                const headings = []
                $('h1, h2, h3, h4').each((_, el) => {
                    const tag = el.tagName.toLowerCase()
                    const text = $(el).text().trim()
                    if (text) headings.push({ tag, text: text.slice(0, 300) })
                })

                const paragraphs = []
                $('p').each((_, el) => {
                    const text = $(el).text().trim()
                    if (text.length > 40) paragraphs.push(text.slice(0, 1000))
                })

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

                const jsonLd = []
                $('script[type="application/ld+json"]').each((_, el) => {
                    try {
                        const parsed = JSON.parse($(el).html())
                        jsonLd.push(parsed)
                    } catch {}
                })

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

app.get('/api/status', (_, res) => {
    res.json({
        browserStatus,
        queue: scrapeQueue.getStats(),
        uptime: process.uptime()
    })
})

app.get('/api/scrape', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress

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