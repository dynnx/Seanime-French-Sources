/// <reference path="./anime-torrent-provider.d.ts" />

/**
 * OxTorrent — Anime Torrent Provider for Seanime (v2)
 * ---------------------------------------------------
 * The old public OxTorrent (.com/.vc/.co) is dead. The live site is
 * https://www.oxtorrent.vip — it is SEMI-PRIVATE (account required) and sits
 * behind an interstitial gate. A plain request only gets the gate page, which
 * is why an unauthenticated search returns 0 results.
 *
 * => To make this work you MUST:
 *    1. Log in to the site in your browser.
 *    2. Copy the value of the `Cookie` request header (DevTools > Network >
 *       any request to the site > Request Headers > Cookie).
 *    3. Paste it into this extension's "Session cookie" setting.
 *
 * Site model (Torrent9-family engine, current era):
 *   Search page : {domain}/recherche/{query}
 *   Rows        : 4-column table -> title/link | size | seeders | leechers
 *   Detail link : /detail/{id}/{slug}   (older skins used /torrent/{id}/{slug})
 *   Magnet      : on the detail page (a[href^="magnet:"]), with a .torrent
 *                 file link as fallback.
 */
class Provider {
    // Injected by Seanime from userConfig. In the Playground these stay as the
    // literal placeholders, so we detect that and fall back gracefully.
    private rawDomain = "{{domain}}"
    private rawCookie = "{{cookie}}"

    private baseUrl(): string {
        let d = this.rawDomain
        if (!d || d.indexOf("http") !== 0) {
            d = "https://www.oxtorrent.vip"
        }
        return d.replace(/\/+$/, "")
    }

    private cookie(): string {
        const c = this.rawCookie
        if (!c || c.indexOf("{{") !== -1) return ""
        return c.trim()
    }

    private headers(): { [key: string]: string } {
        const h: { [key: string]: string } = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Referer": this.baseUrl() + "/",
        }
        const c = this.cookie()
        if (c) h["Cookie"] = c
        return h
    }

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["query", "batch", "episodeNumber", "resolution"],
            supportsAdult: false,
            type: "main",
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        return this.fetchTorrents(opts.query)
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const queries = this.buildSmartQueries(opts)

        const seen: { [key: string]: boolean } = {}
        let results: AnimeTorrent[] = []

        for (let i = 0; i < queries.length; i++) {
            let batch: AnimeTorrent[] = []
            try {
                batch = await this.fetchTorrents(queries[i])
            } catch (e) {
                batch = []
            }
            for (let j = 0; j < batch.length; j++) {
                const t = batch[j]
                const key = t.link || t.name
                if (key && !seen[key]) {
                    seen[key] = true
                    results.push(t)
                }
            }
        }

        // Optional resolution narrowing. Only apply if it doesn't wipe everything.
        if (opts.resolution) {
            const wanted = opts.resolution.replace("p", "")
            const filtered = results.filter((t) => {
                const hay = (t.name + " " + (t.resolution || "")).toLowerCase()
                return hay.indexOf(wanted) !== -1
            })
            if (filtered.length > 0) {
                results = filtered
            }
        }

        return results
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(this.baseUrl() + "/", { headers: this.headers() })
            return this.parseRows(res.text())
        } catch (e) {
            return []
        }
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        if (torrent.infoHash) return torrent.infoHash
        const magnet = await this.getTorrentMagnetLink(torrent)
        return this.extractInfoHash(magnet)
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        if (!torrent.link) return ""

        const res = await fetch(torrent.link, { headers: this.headers() })
        const html = res.text()
        const $ = LoadDoc(html)

        // 1) Direct magnet anchor
        const magnets = $('a[href^="magnet:"]').map((i, el) => el.attr("href"))
        for (let i = 0; i < magnets.length; i++) {
            if (magnets[i]) return magnets[i]
        }

        // 2) Fallback: fetch the .torrent file and derive the magnet from it
        const fileSelectors = [
            'a[href*="get_torrent"]',
            'a[href*="/telecharger"]',
            'a[href*="download"]',
        ]
        for (let s = 0; s < fileSelectors.length; s++) {
            const hrefs = $(fileSelectors[s]).map((i, el) => el.attr("href"))
            for (let i = 0; i < hrefs.length; i++) {
                let href = hrefs[i]
                if (!href) continue
                if (href.indexOf("http") !== 0) {
                    if (href.indexOf("/") !== 0) href = "/" + href
                    href = this.baseUrl() + href
                }
                try {
                    const tRes = await fetch(href, { headers: this.headers() })
                    const magnet = $torrentUtils.getMagnetLinkFromTorrentData(tRes.text())
                    if (magnet) return magnet
                } catch (e) {
                    // try the next candidate
                }
            }
        }

        this.warnIfGated(html, "detail page")
        return ""
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private buildSmartQueries(opts: AnimeSmartSearchOptions): string[] {
        const titles: string[] = []
        const addTitle = (s: string | null | undefined) => {
            if (s && s.trim().length > 0 && titles.indexOf(s.trim()) === -1) {
                titles.push(s.trim())
            }
        }

        if (opts.query && opts.query.trim().length > 0) {
            addTitle(opts.query)
        } else {
            addTitle(opts.media.romajiTitle)
            addTitle(opts.media.englishTitle)
            const syn = opts.media.synonyms || []
            for (let i = 0; i < syn.length && i < 2; i++) {
                addTitle(syn[i])
            }
        }

        const queries: string[] = []
        const addQuery = (q: string) => {
            if (q && queries.indexOf(q) === -1) queries.push(q)
        }

        for (let i = 0; i < titles.length; i++) {
            const base = titles[i]
            if (opts.batch) {
                addQuery(base)
            } else if (opts.episodeNumber && opts.episodeNumber > 0) {
                addQuery(base + " " + this.pad(opts.episodeNumber))
                addQuery(base) // broad fallback
            } else {
                addQuery(base)
            }
        }

        return queries
    }

    private async fetchTorrents(query: string): Promise<AnimeTorrent[]> {
        if (!query || query.trim().length === 0) return []
        const q = encodeURIComponent(query.trim()).replace(/%20/g, "+")
        const url = this.baseUrl() + "/recherche/" + q
        const res = await fetch(url, { headers: this.headers() })
        const html = res.text()
        const torrents = this.parseRows(html)
        if (torrents.length === 0) {
            this.warnIfGated(html, "search page")
        }
        return torrents
    }

    private parseRows(html: string): AnimeTorrent[] {
        if (!html) return []
        const $ = LoadDoc(html)

        // The skin changes between mirrors/eras; try selectors from most to
        // least specific. A row only counts if its first-cell link points to a
        // torrent detail page (/detail/ on the current site, /torrent/ on
        // older skins).
        const rowSelectors = [
            "div.listing-torrent > table tbody tr",
            "table.table-hover tbody tr",
            ".table-responsive table tbody tr",
            "table tbody tr",
        ]

        for (let s = 0; s < rowSelectors.length; s++) {
            const out: AnimeTorrent[] = []
            const mapped = $(rowSelectors[s]).map((i, tr) => {
                const link = tr.find("td:nth-child(1) a")
                const name = (link.text() || "").trim()
                let href = (link.attr("href") || "").trim()
                if (!name || !href) return null
                if (href.indexOf("/detail/") === -1 && href.indexOf("/torrent/") === -1) {
                    return null
                }

                if (href.indexOf("http") !== 0) {
                    if (href.indexOf("/") !== 0) href = "/" + href
                    href = this.baseUrl() + href
                }

                const sizeText = (tr.find("td:nth-child(2)").text() || "").trim()
                const seeders = this.toInt(tr.find("td:nth-child(3)").text())
                const leechers = this.toInt(tr.find("td:nth-child(4)").text())

                const parsed = $habari.parse(name)

                const torrent: AnimeTorrent = {
                    name: name,
                    date: "",
                    size: this.sizeToBytes(sizeText),
                    formattedSize: "", // let Seanime format bytes
                    seeders: seeders,
                    leechers: leechers,
                    downloadCount: 0,
                    link: href,
                    downloadUrl: "",
                    magnetLink: "", // scraped lazily from the detail page
                    infoHash: "",
                    resolution: parsed && parsed.video_resolution ? parsed.video_resolution : "",
                    isBatch: false, // let Seanime parse the name
                    episodeNumber: -1, // let Seanime parse the name
                    releaseGroup: parsed && parsed.release_group ? parsed.release_group : "",
                    isBestRelease: false,
                    confirmed: false,
                }
                return torrent
            })

            for (let i = 0; i < mapped.length; i++) {
                if (mapped[i]) out.push(mapped[i] as AnimeTorrent)
            }
            if (out.length > 0) return out
        }

        return []
    }

    // Logs a clear reason in the console/Playground when the site returned a
    // gate/login page instead of results.
    private warnIfGated(html: string, where: string): void {
        if (!html) return
        const h = html.toLowerCase()
        if (
            h.indexOf("tr_uuid") !== -1 ||
            h.indexOf("click here to enter") !== -1 ||
            h.indexOf("just a moment") !== -1 ||
            h.indexOf("cf-browser-verification") !== -1
        ) {
            console.error(
                "[OxTorrent] The " + where + " returned an interstitial/anti-bot gate, " +
                "not the site. Open the site in your browser, log in, and paste your " +
                "Cookie header into the extension settings."
            )
        } else if (h.indexOf("connexion") !== -1 && h.indexOf("mot de passe") !== -1) {
            console.error(
                "[OxTorrent] The " + where + " returned the login page. OxTorrent is " +
                "semi-private: create an account, log in in your browser, then paste " +
                "your Cookie header into the extension settings."
            )
        }
    }

    private extractInfoHash(magnet: string): string {
        if (!magnet) return ""
        const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]+)/)
        return m ? m[1].toLowerCase() : ""
    }

    // Sizes appear in French (Ko/Mo/Go/To) or English (KB/MB/GB/TB) units
    // depending on the skin. Decimal multipliers, matching the Jackett filters.
    private sizeToBytes(text: string): number {
        if (!text) return 0
        const cleaned = text.replace(",", ".")
        const m = cleaned.match(/([\d.]+)\s*(To|Go|Mo|Ko|TB|GB|MB|KB|o|B)\b/i)
        if (!m) return 0
        const value = parseFloat(m[1])
        if (isNaN(value)) return 0
        const unit = m[2].toLowerCase()
        let mult = 1
        if (unit === "ko" || unit === "kb") mult = 1e3
        else if (unit === "mo" || unit === "mb") mult = 1e6
        else if (unit === "go" || unit === "gb") mult = 1e9
        else if (unit === "to" || unit === "tb") mult = 1e12
        return Math.round(value * mult)
    }

    private toInt(text: string): number {
        if (!text) return 0
        const n = parseInt((text + "").replace(/[^\d]/g, ""), 10)
        return isNaN(n) ? 0 : n
    }

    private pad(n: number): string {
        return n < 10 ? "0" + n : "" + n
    }
}
