/// <reference path="./anime-torrent-provider.d.ts" />

/**
 * OxTorrent — Anime Torrent Provider for Seanime
 * -------------------------------------------------
 * OxTorrent is a French PUBLIC general torrent index (Torrent9-family engine).
 * It is NOT anime-only, so results can be noisy and are mostly FRENCH releases
 * (VF / VOSTFR). Accuracy for auto-select is therefore "low" — this is inherent
 * to scraping a general site, not a bug.
 *
 * The base URL is configurable (userConfig `domain`) because OxTorrent rotates
 * domains frequently. If the provider suddenly returns nothing, the domain has
 * probably moved — update it in the extension settings.
 *
 * Scraping model (verified against the Jackett OxTorrent definition):
 *   Search page : {domain}/recherche/{query}
 *   Rows        : div.listing-torrent > table tbody tr
 *   Title/link  : td:nth-child(1) a   (text = name, href = /torrent/{id}/{slug})
 *   Size        : td:nth-child(2)     (French units: To/Go/Mo/Ko)
 *   Seeders     : td:nth-child(3)
 *   Leechers    : td:nth-child(4)
 *   Magnet      : on the detail page  ->  a[href^="magnet:"]
 */
class Provider {
    // Raw value injected by Seanime from userConfig. Falls back to a sane default
    // if the placeholder was never substituted (e.g. tested in the Playground).
    private rawDomain = "{{domain}}"

    private baseUrl(): string {
        let d = this.rawDomain
        if (!d || d.indexOf("http") !== 0) {
            d = "https://www.oxtorrent.vc"
        }
        return d.replace(/\/+$/, "")
    }

    private headers(): { [key: string]: string } {
        return {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Referer": this.baseUrl() + "/",
        }
    }

    getSettings(): AnimeProviderSettings {
        return {
            // We accept a custom query and can narrow by resolution / batch.
            canSmartSearch: true,
            smartSearchFilters: ["query", "batch", "resolution"],
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
        // OxTorrent has no anime-only feed; return recent items from the homepage.
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
        const $ = LoadDoc(res.text())

        const magnets = $('a[href^="magnet:"]').map((i, el) => el.attr("href"))
        for (let i = 0; i < magnets.length; i++) {
            if (magnets[i]) return magnets[i]
        }
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
        return this.parseRows(res.text())
    }

    private parseRows(html: string): AnimeTorrent[] {
        if (!html) return []
        const $ = LoadDoc(html)

        const mapped = $("div.listing-torrent > table tbody tr").map((i, tr) => {
            const link = tr.find("td:nth-child(1) a")
            const name = (link.text() || "").trim()
            let href = (link.attr("href") || "").trim()
            if (!name || !href) return null

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
                // Left empty so Seanime formats bytes into "x.x GB" itself.
                formattedSize: "",
                seeders: seeders,
                leechers: leechers,
                downloadCount: 0,
                link: href,
                downloadUrl: "",
                // Magnet + infoHash are scraped lazily from the detail page.
                magnetLink: "",
                infoHash: "",
                resolution: parsed && parsed.video_resolution ? parsed.video_resolution : "",
                isBatch: false, // let Seanime parse the name
                episodeNumber: -1, // let Seanime parse the name
                releaseGroup: parsed && parsed.release_group ? parsed.release_group : "",
                isBestRelease: false,
                confirmed: false, // cannot confirm via AniDB on a general site
            }
            return torrent
        })

        const out: AnimeTorrent[] = []
        for (let i = 0; i < mapped.length; i++) {
            if (mapped[i]) out.push(mapped[i] as AnimeTorrent)
        }
        return out
    }

    private extractInfoHash(magnet: string): string {
        if (!magnet) return ""
        const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]+)/)
        return m ? m[1].toLowerCase() : ""
    }

    // OxTorrent reports sizes in French units. Following the Jackett definition,
    // treat them as decimal (Ko = 1e3, Mo = 1e6, Go = 1e9, To = 1e12).
    private sizeToBytes(text: string): number {
        if (!text) return 0
        const cleaned = text.replace(",", ".")
        const m = cleaned.match(/([\d.]+)\s*(To|Go|Mo|Ko|o)\b/i)
        if (!m) return 0
        const value = parseFloat(m[1])
        if (isNaN(value)) return 0
        const unit = m[2].toLowerCase()
        let mult = 1
        if (unit === "ko") mult = 1e3
        else if (unit === "mo") mult = 1e6
        else if (unit === "go") mult = 1e9
        else if (unit === "to") mult = 1e12
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
