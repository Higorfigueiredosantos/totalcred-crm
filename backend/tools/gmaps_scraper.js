// Versão original do WASenderAI — adaptada para puppeteer-core (sem browser embutido)
const puppeteer = require('whatsapp-web.js/node_modules/puppeteer-core');
const fs = require('fs');

let browser = null;
let isScraping = false;

function findBrowserPath() {
    const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

async function startGmapsScraper(query, limit, broadcast) {
    if (isScraping) return;
    isScraping = true;

    try {
        const executablePath = findBrowserPath();
        if (!executablePath) {
            broadcast({ type: 'gmaps_log', message: 'Erro: Edge/Chrome não encontrado.' });
            broadcast({ type: 'gmaps_done' });
            isScraping = false;
            return;
        }

        // userDataDir único e isolado: impede que Edge/Chrome abra nova aba no browser do usuário
        const os = require('os');
        const path = require('path');
        const tmpProfile = path.join(os.tmpdir(), `gmaps_${Date.now()}`);

        browser = await puppeteer.launch({
            headless: 'new',
            executablePath,
            userDataDir: tmpProfile,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--disable-blink-features=AutomationControlled',
                '--lang=pt-BR,pt'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

        // ======================================================
        // FASE 1: Coletar todos os URLs dos places no feed
        // ======================================================
        const searchUrl = `https://www.google.com.br/maps/search/${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        await page.waitForSelector('[role="feed"]', { timeout: 12000 }).catch(() => { });

        const placeUrls = new Set();
        let noNewCount = 0;

        broadcast({ type: 'gmaps_log', message: 'Coletando URLs dos lugares...' });

        while (isScraping && placeUrls.size < limit) {
            const found = await page.evaluate(() => {
                const links = [];
                document.querySelectorAll('.hfpxzc, .Nv2PK a[href*="/maps/place/"]').forEach(el => {
                    const href = el.href || el.getAttribute('href') || '';
                    if (href.includes('/maps/place/')) links.push(href);
                });
                return links;
            });

            const prevSize = placeUrls.size;
            found.forEach(u => placeUrls.add(u));

            broadcast({ type: 'gmaps_log', message: `URLs coletadas: ${placeUrls.size}` });

            if (placeUrls.size === prevSize) {
                noNewCount++;
                if (noNewCount >= 4) break;
            } else {
                noNewCount = 0;
            }

            await page.evaluate(() => {
                const feed = document.querySelector('[role="feed"]');
                if (feed) feed.scrollBy(0, 1200);
            });
            await new Promise(r => setTimeout(r, 2500));
        }

        const urlList = [...placeUrls].slice(0, limit);
        broadcast({ type: 'gmaps_log', message: `${urlList.length} lugares encontrados. Extraindo dados...` });

        // ======================================================
        // FASE 2: Visitar cada URL individual e extrair dados
        // ======================================================
        let extracted = 0;

        for (const placeUrl of urlList) {
            if (!isScraping) break;

            try {
                await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await new Promise(r => setTimeout(r, 1000));

                const data = await page.evaluate(() => {
                    const nameEl = document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge, [data-item-id="title"]');
                    const name = nameEl ? nameEl.textContent.trim() : document.title.split(' - ')[0].trim();

                    let phone = '';
                    const phoneSelectors = [
                        '[data-item-id^="phone:tel:"]',
                        '[aria-label^="Telefone:"]',
                        '[aria-label^="Ligar:"]',
                        '[data-tooltip="Copiar número de telefone"]',
                        'button[data-tooltip*="telefone"]',
                        '[href^="tel:"]'
                    ];
                    for (const sel of phoneSelectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            phone = el.getAttribute('aria-label')
                                || el.getAttribute('data-item-id')
                                || el.getAttribute('href')
                                || el.textContent || '';
                            phone = phone.replace(/^(Telefone:|Ligar:|tel:|phone:tel:)/gi, '').trim();
                            if (phone) break;
                        }
                    }

                    if (!phone) {
                        const bodyText = document.body.innerText;
                        const m = bodyText.match(/(?:\+?55\s?)?(?:\(?[1-9][1-9]\)?\s?)?\d{4,5}[-\s]?\d{4}/);
                        if (m) phone = m[0];
                    }

                    let address = '';
                    const addrSelectors = [
                        '[data-item-id="address"]',
                        '[aria-label^="Endereço:"]',
                        'button[data-tooltip="Copiar endereço"]',
                        '[data-item-id^="address"]'
                    ];
                    for (const sel of addrSelectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            address = el.getAttribute('aria-label')
                                || el.querySelector('.rogA2c, .Io6YTe')?.textContent
                                || el.textContent || '';
                            address = address.replace(/^Endereço:\s*/i, '').trim();
                            if (address) break;
                        }
                    }

                    return { name, phone, address };
                });

                if (data.name) {
                    extracted++;
                    broadcast({ type: 'gmaps_result', data, current: extracted, total: urlList.length });
                    broadcast({ type: 'gmaps_log', message: `[${extracted}/${urlList.length}] ${data.name} | ${data.phone}` });
                }

            } catch (err) {
                console.error(`[GMaps] Erro em ${placeUrl}:`, err.message);
            }

            await new Promise(r => setTimeout(r, 500));
        }

    } catch (error) {
        console.error('[GMaps Scraper] Erro geral:', error.message);
        broadcast({ type: 'gmaps_log', message: 'Erro: ' + error.message });
    } finally {
        isScraping = false;
        if (browser) await browser.close().catch(() => { });
        browser = null;
        broadcast({ type: 'gmaps_done' });
    }
}

function stopGmapsScraper() {
    isScraping = false;
    if (browser) {
        browser.close().catch(() => { }).finally(() => { browser = null; });
    }
}

function getScrapingStatus() { return { isScraping }; }

module.exports = { startGmapsScraper, stopGmapsScraper, getScrapingStatus };
