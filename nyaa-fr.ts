/// <reference path="./anime-torrent-provider.d.ts" />

/*
 * Nyaa (French) provider for Seanime
 * ----------------------------------
 * Sources anime torrents from Nyaa (https://nyaa.si) and keeps the French
 * releases (VOSTFR / VF / MULTI / FRENCH). Built after YggTorrent + yggapi.eu
 * went dark — Nyaa is public and hit directly, so there is no fragile proxy to
 * die on you and, crucially, NO PASSKEY to configure.
 *
 * How it works:
 *   - Search / smart search  -> Nyaa's RSS endpoint (/?page=rss&q=...&c=1_3)
 *                               category 1_3 = "Anime - Non-English-translated",
 *                               where French subs live. Results are then filtered
 *                               to French-tagged releases.
 *   - Nyaa is a PUBLIC tracker (DHT on), so we hand Seanime a real magnet link
 *     built from the info hash in the RSS, plus the direct .torrent download URL.
 *     No passkey, no login.
 *
 * Everything is configurable in the extension settings (see the README): French
 * filter on/off, category, sort order, trusted-only, and a mirror base URL.
 */

interface NyaaItem {
    title: string
    link: string        // direct .torrent download URL
    guid: string        // torrent view page
    pubDate: string     // normalised to RFC3339
    seeders: number
    leechers: number
    downloads: number
    infoHash: string
    sizeBytes: number
    categoryId: string
}

const USER_AGENT = "Seanime-Nyaa-FR/1.0"

// Public trackers Nyaa torrents announce to — bolted onto constructed magnets so
// they resolve peers even for clients that lean on trackers over DHT.
const TRACKERS = [
    "http://nyaa.tracker.wf:7777/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
]

const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

// Markers that flag a release as French (or French-inclusive, e.g. MULTI).
const FRENCH_RE = /(vostfr|vost\.fr|truefrench|\bfrench\b|\bmulti\b|\bvff?\b|\bvfq\b|\bvfi\b|\[fr\]|\(fr\)|\bfr\b|\bfre\b|\bfra\b)/i

class Provider {

    // ---- Config ------------------------------------------------------------

    private getConfig() {
        const rawBase = ($getUserPreference("baseUrl") || "https://nyaa.si").trim()
        const baseUrl = rawBase.replace(/\/+$/, "")

        let category = ($getUserPreference("category") || "1_3").trim()
        if (["1_3", "1_0", "1_2"].indexOf(category) === -1) category = "1_3"

        let sort = ($getUserPreference("sort") || "seeders").trim()
        if (["seeders", "date", "downloads", "size"].indexOf(sort) === -1) sort = "seeders"

        const frenchOnly = (($getUserPreference("frenchOnly") || "true") === "true")
        const trustedOnly = (($getUserPreference("trustedOnly") || "false") === "true")

        return { baseUrl, category, sort, frenchOnly, trustedOnly }
    }

    getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    // ---- HTTP + RSS --------------------------------------------------------

    private buildRssUrl(text: string, opts?: { category?: string; sort?: string }): string {
        const cfg = this.getConfig()
        const cat = (opts && opts.category) || cfg.category
        const sortMode = (opts && opts.sort) || cfg.sort

        const params: string[] = ["page=rss"]
        params.push("c=" + encodeURIComponent(cat))
        params.push("f=" + (cfg.trustedOnly ? "2" : "0"))
        if (sortMode === "seeders") { params.push("s=seeders"); params.push("o=desc") }
        else if (sortMode === "downloads") { params.push("s=downloads"); params.push("o=desc") }
        else if (sortMode === "size") { params.push("s=size"); params.push("o=desc") }
        // "date" -> Nyaa's default order (newest first), so no sort param.
        if (text) params.push("q=" + encodeURIComponent(text))

        return cfg.baseUrl + "/?" + params.join("&")
    }

    private async fetchRss(url: string): Promise<string> {
        try {
            const res = await fetch(url, {
                timeout: 30,
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/rss+xml, application/xml, text/xml, */*",
                },
            })
            if (!res.ok) {
                console.error("[nyaa-fr] http " + res.status + " for " + url)
                return ""
            }
            return res.text()
        } catch (e) {
            console.error("[nyaa-fr] fetch failed:", e)
            return ""
        }
    }

    private tagText(block: string, name: string): string {
        const re = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i")
        const m = block.match(re)
        if (!m) return ""
        let v = m[1]
        const cd = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
        if (cd) v = cd[1]
        return v
    }

    private decodeEntities(s: string): string {
        if (!s) return ""
        return s
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&")
    }

    private parseRss(xml: string): NyaaItem[] {
        const items: NyaaItem[] = []
        if (!xml) return items
        const blocks = xml.split(/<item\b[^>]*>/i)
        for (let i = 1; i < blocks.length; i++) {
            const raw = blocks[i]
            const end = raw.search(/<\/item>/i)
            const block = end === -1 ? raw : raw.slice(0, end)

            const title = this.decodeEntities(this.tagText(block, "title")).trim()
            if (!title) continue

            items.push({
                title: title,
                link: this.tagText(block, "link").trim(),
                guid: this.tagText(block, "guid").trim(),
                pubDate: this.toRfc3339(this.tagText(block, "pubDate").trim()),
                seeders: parseInt(this.tagText(block, "nyaa:seeders") || "0", 10) || 0,
                leechers: parseInt(this.tagText(block, "nyaa:leechers") || "0", 10) || 0,
                downloads: parseInt(this.tagText(block, "nyaa:downloads") || "0", 10) || 0,
                infoHash: (this.tagText(block, "nyaa:infoHash") || "").trim().toLowerCase(),
                sizeBytes: this.sizeToBytes(this.tagText(block, "nyaa:size")),
                categoryId: (this.tagText(block, "nyaa:categoryId") || "").trim(),
            })
        }
        return items
    }

    // ---- Small utilities ---------------------------------------------------

    private isFrench(title: string): boolean {
        return FRENCH_RE.test(title || "")
    }

    private sizeToBytes(s: string): number {
        if (!s) return 0
        const m = s.trim().match(/([\d.]+)\s*([KMGT]?i?B)/i)
        if (!m) return 0
        const val = parseFloat(m[1])
        if (isNaN(val)) return 0
        const unit = m[2].toUpperCase()
        const table: Record<string, number> = {
            "B": 1,
            "KB": 1000, "MB": 1000000, "GB": 1000000000, "TB": 1000000000000,
            "KIB": 1024, "MIB": 1048576, "GIB": 1073741824, "TIB": 1099511627776,
        }
        return Math.round(val * (table[unit] || 1))
    }

    private toRfc3339(pubDate: string): string {
        if (!pubDate) return ""
        // Nyaa RSS pubDate is always UTC, e.g. "Mon, 01 Jul 2026 12:34:56 -0000".
        const m = pubDate.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
        if (m) {
            const mon = MONTHS[m[2]]
            if (mon !== undefined) {
                const dt = new Date(Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]))
                if (!isNaN(dt.getTime())) return dt.toISOString().replace(/\.\d{3}Z$/, "Z")
            }
        }
        const d = new Date(pubDate)
        if (!isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, "Z")
        return ""
    }

    private formatBytes(bytes: number): string {
        if (!bytes || bytes <= 0) return ""
        const units = ["B", "KB", "MB", "GB", "TB"]
        let i = 0
        let n = bytes
        while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++ }
        const decimals = (n >= 10 || i === 0) ? 0 : 1
        return n.toFixed(decimals) + " " + units[i]
    }

    private zeroPad2(n: number): string {
        return n < 10 ? "0" + n : "" + n
    }

    private buildMagnet(hash: string, name: string): string {
        if (!hash) return ""
        let mag = "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name)
        for (const t of TRACKERS) mag += "&tr=" + encodeURIComponent(t)
        return mag
    }

    // ---- Result mapping ----------------------------------------------------

    private mapItem(it: NyaaItem): AnimeTorrent {
        let resolution = ""
        let releaseGroup = ""
        let episodeNumber = -1
        let isBatch = false
        try {
            const meta = $habari.parse(it.title)
            if (meta.video_resolution) {
                resolution = /p$/i.test(meta.video_resolution) ? meta.video_resolution : meta.video_resolution + "p"
            }
            if (meta.release_group) releaseGroup = meta.release_group
            const eps = meta.episode_number || []
            if (eps.length === 1) {
                const n = parseInt(eps[0], 10)
                if (!isNaN(n)) episodeNumber = n
            } else if (eps.length > 1) {
                isBatch = true
            }
        } catch (e) { /* parsing is best-effort */ }

        if (!isBatch && /(\bbatch\b|\bcomplete\b|\bcomplet\b|int[eé]grale|\bsaison\b|\bseason\b|\d{1,3}\s*[-~]\s*\d{1,3})/i.test(it.title)) {
            isBatch = true
        }

        return {
            provider: "nyaa-fr",
            name: it.title,
            date: it.pubDate,
            size: it.sizeBytes || 0,
            formattedSize: this.formatBytes(it.sizeBytes || 0),
            seeders: it.seeders || 0,
            leechers: it.leechers || 0,
            downloadCount: it.downloads || 0,
            link: it.guid || it.link || "",
            downloadUrl: it.link || "",                          // public .torrent, no auth
            magnetLink: this.buildMagnet(it.infoHash, it.title),  // public tracker: real magnet
            infoHash: it.infoHash || "",
            resolution: resolution,
            isBatch: isBatch,
            episodeNumber: episodeNumber,
            releaseGroup: releaseGroup,
            isBestRelease: false,
            confirmed: false,
        }
    }

    private async query(text: string, opts?: { category?: string; sort?: string }): Promise<NyaaItem[]> {
        const url = this.buildRssUrl(text, opts)
        const xml = await this.fetchRss(url)
        let items = this.parseRss(xml)
        if (this.getConfig().frenchOnly) {
            items = items.filter((it) => this.isFrench(it.title))
        }
        return items
    }

    private finalize(items: NyaaItem[]): AnimeTorrent[] {
        const seen: Record<string, boolean> = {}
        const out: AnimeTorrent[] = []
        for (const it of items) {
            const key = it.infoHash || it.guid || it.link
            if (!key || seen[key]) continue
            seen[key] = true
            out.push(this.mapItem(it))
        }
        return out
    }

    // ---- Interface ---------------------------------------------------------

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const media: any = opts.media || {}
        const query = (opts.query || media.romajiTitle || (media.englishTitle || "") || "").trim()
        if (!query) return []
        const items = await this.query(query)
        return this.finalize(items)
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const media: any = opts.media || {}

        const candidates: string[] = []
        if (media.romajiTitle) candidates.push(media.romajiTitle)
        if (media.englishTitle) candidates.push(media.englishTitle)
        if (media.synonyms) for (const s of media.synonyms) if (s) candidates.push(s)

        let primaryTitle = ""
        let season = -1
        try {
            const built = $scannerUtils.buildSmartSearchTitles(candidates.length ? candidates : [""])
            if (built && built.titles && built.titles.length) primaryTitle = built.titles[0]
            if (built) season = built.season
        } catch (e) { /* fall back below */ }
        if (!primaryTitle) primaryTitle = (media.romajiTitle || media.englishTitle || "").trim()

        const userQuery = (opts.query || "").trim()
        let baseQuery = userQuery || primaryTitle
        if (!userQuery && season > 1) baseQuery = baseQuery + " S" + this.zeroPad2(season)
        if (opts.resolution) baseQuery = baseQuery + " " + opts.resolution
        if (!baseQuery.trim()) return []

        let collected: NyaaItem[] = []

        // Broad title search (surfaces batches + episodes).
        collected = collected.concat(await this.query(baseQuery))

        // Targeted episode query so a specific episode still shows up for
        // long-running shows whose episodes fall past the first RSS page.
        if (!opts.batch && opts.episodeNumber && opts.episodeNumber > 0) {
            let epQuery = (userQuery || primaryTitle) + " " + this.zeroPad2(opts.episodeNumber)
            if (opts.resolution) epQuery += " " + opts.resolution
            collected = collected.concat(await this.query(epQuery))
        }

        return this.finalize(collected)
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        // Newest French releases in the configured category.
        const items = await this.query("", { sort: "date" })
        return this.finalize(items)
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        // Nyaa's RSS already gave us the info hash at search time.
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        return this.buildMagnet(torrent.infoHash, torrent.name)
    }
}
