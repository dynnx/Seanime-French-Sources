/// <reference path="./anime-torrent-provider.d.ts" />

/**
 * Torrent9 — Anime Torrent Provider for Seanime
 * ---------------------------------------------
 * Why Torrent9 and not OxTorrent: as of 2026 OxTorrent is dead (its domains are
 * ad gates / semi-private walls, and Jackett removed every OxTorrent definition).
 * Torrent9 is the surviving site of the same family — still PUBLIC, no account —
 * and "oxtorrent.me" is literally one of its legacy mirror domains.
 *
 * Mechanics (mirrored from the actively maintained Jackett torrent9 definition):
 *   Search : {domain}/search_torrent/{query-with-dashes}.html
 *   Latest : {domain}/home/
 *   Rows   : table.table-striped > tbody > tr
 *   Search columns : td1 title/link · td2 date (dd/MM/yyyy) · td3 size · td4 seeds · td5 leech
 *   Home columns   : td1 title/link · td2 size · td3 seeds · td4 leech
 *   Magnet : detail page a[href^="magnet:?"], or embedded in a <script> as 'magnet:?...'
 *   Quirk  : the site BLOCKS Linux user agents -> always send a Windows UA.
 *
 * Note: Seanime's fetch() attempts a Cloudflare bypass automatically.
 */
class Provider {
    // Injected by Seanime from userConfig; stays literal in the Playground,
    // in which case we fall back to the default domain below.
    private rawDomain = "{{domain}}"

    private baseUrl(): string {
        let d = this.rawDomain
        if (!d || d.indexOf("http") !== 0) {
            d = "https://www6.torrent9.to"
        }
        return d.replace(/\/+$/, "")
    }

    private headers(): { [key: string]: string } {
        return {
            // Windows UA is mandatory: the site rejects Linux user agents.
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
            canSmartSearch: true,
            // No per-episode search on this site: we return the title's catalogue
            // and let Seanime's parser pick episodes/batches from release names.
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
                console.error("[Torrent9] query failed: " + queries[i] + " -> " + e)
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

        // Optional resolution narrowing; only applied when it keeps results.
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
            const res = await fetch(this.baseUrl() + "/home/", { headers: this.headers() })
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
        const magnets = $('a[href^="magnet:?"]').map((i, el) => el.attr("href"))
        for (let i = 0; i < magnets.length; i++) {
            if (magnets[i]) return magnets[i] as string
        }

        // 2) Magnet embedded in an inline <script> (current site behavior)
        const m = html.match(/'(magnet:\?[^']+)'/)
        if (m && m[1]) return m[1]

        this.warnIfBlocked(html, "detail page")
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

        return titles
    }

    private async fetchTorrents(query: string): Promise<AnimeTorrent[]> {
        if (!query || query.trim().length === 0) return []

        // Site convention (from the Jackett definition):
        //  - trailing "S01" style tokens become "saison 1"
        //  - spaces become dashes
        let q = query.trim()
        q = q.replace(/\bS0?(\d{1,3})\s*$/i, "saison $1")
        q = q.replace(/['’:!?,.()]/g, " ")
        const slug = encodeURIComponent(
            q.trim().replace(/\s+/g, "-")
        )

        const url = this.baseUrl() + "/search_torrent/" + slug + ".html"
        const res = await fetch(url, { headers: this.headers() })
        const html = res.text()
        const torrents = this.parseRows(html)
        if (torrents.length === 0) {
            this.warnIfBlocked(html, "search page")
        }
        return torrents
    }

    private parseRows(html: string): AnimeTorrent[] {
        if (!html) return []
        const $ = LoadDoc(html)

        const rowSelectors = [
            "table.table-striped > tbody > tr",
            ".table-responsive table tbody tr",
            "table tbody tr",
        ]

        for (let s = 0; s < rowSelectors.length; s++) {
            const out: AnimeTorrent[] = []
            const mapped = $(rowSelectors[s]).map((i, tr) => {
                const link = tr.find("td:nth-child(1) a")
                let name = (link.attr("title") || "").trim()
                if (!name) name = (link.text() || "").trim()
                let href = (link.attr("href") || "").trim()
                if (!name || !href) return null
                if (href.indexOf("/torrent") === -1 && href.indexOf("/detail") === -1) {
                    return null
                }

                if (href.indexOf("http") !== 0) {
                    if (href.indexOf("/") !== 0) href = "/" + href
                    href = this.baseUrl() + href
                }

                // Column layout differs between search results and the homepage:
                // search rows have a dd/MM/yyyy date in column 2.
                const col2 = (tr.find("td:nth-child(2)").text() || "").trim()
                const dateMatch = col2.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
                let date = ""
                let sizeText: string
                let seeders: number
                let leechers: number
                if (dateMatch) {
                    date = dateMatch[3] + "-" + dateMatch[2] + "-" + dateMatch[1] + "T00:00:00Z"
                    sizeText = (tr.find("td:nth-child(3)").text() || "").trim()
                    seeders = this.toInt(tr.find("td:nth-child(4)").text())
                    leechers = this.toInt(tr.find("td:nth-child(5)").text())
                } else {
                    sizeText = col2
                    seeders = this.toInt(tr.find("td:nth-child(3)").text())
                    leechers = this.toInt(tr.find("td:nth-child(4)").text())
                }

                const parsed = $habari.parse(name)

                const torrent: AnimeTorrent = {
                    name: name,
                    date: date,
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
                    releaseGroup: "",
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

    // Explains empty output in the console/Playground instead of failing silently.
    private warnIfBlocked(html: string, where: string): void {
        if (!html) {
            console.error("[Torrent9] Empty response from the " + where + ".")
            return
        }
        const h = html.toLowerCase()
        if (
            h.indexOf("just a moment") !== -1 ||
            h.indexOf("cf-browser-verification") !== -1 ||
            h.indexOf("cloudflare") !== -1
        ) {
            console.error(
                "[Torrent9] The " + where + " returned a Cloudflare challenge. " +
                "Retry later or set a different mirror as the Base URL."
            )
        } else if (h.indexOf("tr_uuid") !== -1 || h.indexOf("click here to enter") !== -1) {
            console.error(
                "[Torrent9] The " + where + " returned an ad/parking gate — this domain " +
                "is likely dead. Set a working mirror as the Base URL."
            )
        }
    }

    private extractInfoHash(magnet: string): string {
        if (!magnet) return ""
        const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]+)/)
        return m ? m[1].toLowerCase() : ""
    }

    // Sizes appear in French (Ko/Mo/Go/To) or English (KB/MB/GB/TB) units
    // depending on the mirror. Decimal multipliers, matching Jackett's filters.
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
}
