/// <reference path="./anime-torrent-provider.d.ts" />

/*
 * Nyaa (French) provider for Seanime
 * ----------------------------------
 * Sources anime torrents from Nyaa (https://nyaa.si), keeps the French releases
 * (VOSTFR / VF / MULTI / FRENCH), and prefers a French dub for auto-select.
 * Nyaa is public, so no passkey and real magnet links.
 *
 * Season / episode handling (the important bit):
 *   Seanime does NOT hand providers a plain "season number"; it gives the
 *   seasonal episode number plus `absoluteSeasonOffset` (episodes before this
 *   season). We DON'T guess a season number and jam "S0X" into the query — that
 *   produced wrong-season results. Instead:
 *     - offset === 0  => treat as first season. Drop releases explicitly tagged
 *       as a later season (S02+, "Season 2", "Saison 2"), and drop single
 *       episodes numbered past this season's length.
 *     - offset  >  0  => a sequel. Keep episodes whose number falls in this
 *       season's seasonal range [1..epCount] OR its absolute range
 *       [offset+1 .. offset+epCount]; drop clearly out-of-range singles.
 *     - When a specific episode is requested, keep only releases matching that
 *       episode in EITHER seasonal or absolute numbering (or batches / unknown).
 *   Parsed absolute numbers are converted back to seasonal so they line up with
 *   what Seanime asked for.
 *
 * Language preference: VF (dub) > MULTI > VOSTFR > other by default; the top
 * pick of the best available track is flagged so Seanime auto-selects it.
 */

interface NyaaItem {
    title: string
    link: string
    guid: string
    pubDate: string
    seeders: number
    leechers: number
    downloads: number
    infoHash: string
    sizeBytes: number
    categoryId: string
}

interface EpisodeCtx {
    requestedEp: number
    offset: number
    epCount: number
    isFirstSeason: boolean
}

const USER_AGENT = "Seanime-Nyaa-FR/1.1"

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

const FRENCH_RE = /(vostfr|vost\.fr|truefrench|\bfrench\b|\bmulti\b|\bvff?\b|\bvfq\b|\bvfi\b|\bvost\b|\[fr\]|\(fr\)|\bfr\b|\bfre\b|\bfra\b)/i

// Batch / pack markers. NOTE: bare "season"/"saison" is deliberately excluded —
// per-episode releases routinely contain the season word ("Show Saison 2 - 05").
const BATCH_RE = /(\bbatch\b|\bcomplete\b|\bcomplet\b|int[eé]grale|\bintegrale\b|\bfull\s*season\b|\d{1,3}\s*[~-]\s*\d{1,3})/i

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
        const audioPref = (($getUserPreference("audioPref") || "vf") === "vostfr") ? "vostfr" : "vf"

        return { baseUrl, category, sort, frenchOnly, trustedOnly, audioPref }
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

    // ---- Parsing helpers ---------------------------------------------------

    private isFrench(title: string): boolean {
        return FRENCH_RE.test(title || "")
    }

    private isBatchTitle(title: string): boolean {
        if (BATCH_RE.test(title || "")) return true
        try {
            const m = $habari.parse(title)
            if ((m.episode_number || []).length > 1) return true
        } catch (e) { /* best-effort */ }
        return false
    }

    // Explicit season number declared in the title, or -1.
    private parseReleaseSeason(title: string): number {
        const t = title || ""
        let m = t.match(/\bS(\d{1,2})(?:E\d{1,3})?\b/i)
        if (m) return parseInt(m[1], 10)
        m = t.match(/\b(?:Season|Saison)\s*(\d{1,2})\b/i)
        if (m) return parseInt(m[1], 10)
        m = t.match(/\b(\d{1,2})\s*(?:st|nd|rd|th|[eè]me|er)\s+(?:Season|Saison)\b/i)
        if (m) return parseInt(m[1], 10)
        return -1
    }

    // Single episode number parsed from the title, or -1 (batches -> -1).
    private parseRawEpisode(title: string): number {
        try {
            const meta = $habari.parse(title)
            const eps = meta.episode_number || []
            if (eps.length === 1) {
                const n = parseInt(eps[0], 10)
                return isNaN(n) ? -1 : n
            }
        } catch (e) { /* best-effort */ }
        return -1
    }

    // "vf" | "multi" | "vostfr" | "other"
    private classifyLang(name: string): string {
        const t = " " + (name || "").toLowerCase() + " "
        if (/\bvff?\b|\bvfq\b|\bvfi\b|\btruefrench\b|\bfrench\b/.test(t)) return "vf"
        if (/\bmulti\b/.test(t)) return "multi"
        if (/\bvostfr\b|\bvost\b|vost\.fr/.test(t)) return "vostfr"
        return "other"
    }

    private resScore(res: string): number {
        const m = (res || "").match(/(\d{3,4})/)
        return m ? parseInt(m[1], 10) : 0
    }

    // ---- Season / episode filtering ---------------------------------------

    private keepForSeason(title: string, f: EpisodeCtx): boolean {
        const batch = this.isBatchTitle(title)
        const relSeason = this.parseReleaseSeason(title)
        const rawEp = batch ? -1 : this.parseRawEpisode(title)

        // First-season selection: reject explicit later seasons and over-length singles.
        if (f.isFirstSeason) {
            if (relSeason >= 2) return false
            if (f.epCount > 0 && !batch && rawEp > 0 && rawEp > f.epCount) return false
        }

        // Specific episode requested: match seasonal OR absolute numbering.
        if (f.requestedEp > 0 && !batch && rawEp > 0) {
            const wantAbs = f.offset > 0 ? f.requestedEp + f.offset : f.requestedEp
            return rawEp === f.requestedEp || rawEp === wantAbs
        }

        // Sequel browse with known length: keep in-range singles only.
        if (!f.isFirstSeason && f.offset > 0 && f.epCount > 0 && !batch && rawEp > 0) {
            const inSeasonal = rawEp >= 1 && rawEp <= f.epCount
            const inAbsolute = rawEp >= (f.offset + 1) && rawEp <= (f.offset + f.epCount)
            if (!inSeasonal && !inAbsolute) return false
        }
        return true
    }

    private filterItems(items: NyaaItem[], f: EpisodeCtx): NyaaItem[] {
        return items.filter((it) => this.keepForSeason(it.title, f))
    }

    // ---- Small utilities ---------------------------------------------------

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

    private pad2(n: number): string {
        return n < 10 ? "0" + n : "" + n
    }

    private buildMagnet(hash: string, name: string): string {
        if (!hash) return ""
        let mag = "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name)
        for (const t of TRACKERS) mag += "&tr=" + encodeURIComponent(t)
        return mag
    }

    private normalizeEpisode(rawEp: number, ctx: EpisodeCtx): number {
        if (rawEp < 0) return -1
        const offset = ctx.offset || 0
        if (offset > 0) {
            if (ctx.requestedEp > 0 && rawEp === ctx.requestedEp + offset) return ctx.requestedEp
            if (ctx.epCount > 0 && rawEp > ctx.epCount) {
                const seasonal = rawEp - offset
                if (seasonal >= 1) return seasonal
            }
        }
        return rawEp
    }

    // ---- Result mapping + ranking -----------------------------------------

    private mapItem(it: NyaaItem, ctx: EpisodeCtx): AnimeTorrent {
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
                if (!isNaN(n)) episodeNumber = this.normalizeEpisode(n, ctx)
            } else if (eps.length > 1) {
                isBatch = true
            }
        } catch (e) { /* best-effort */ }

        if (!isBatch && BATCH_RE.test(it.title)) isBatch = true

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
            downloadUrl: it.link || "",
            magnetLink: this.buildMagnet(it.infoHash, it.title),
            infoHash: it.infoHash || "",
            resolution: resolution,
            isBatch: isBatch,
            episodeNumber: episodeNumber,
            releaseGroup: releaseGroup,
            isBestRelease: false,
            confirmed: false,
        }
    }

    private rankByLanguage(torrents: AnimeTorrent[]): AnimeTorrent[] {
        const pref = this.getConfig().audioPref
        const order: Record<string, number> = pref === "vostfr"
            ? { vostfr: 0, vf: 1, multi: 2, other: 3 }
            : { vf: 0, multi: 1, vostfr: 2, other: 3 }

        const arr = torrents.map((t) => {
            const cls = this.classifyLang(t.name)
            const r = (order[cls] !== undefined) ? order[cls] : 3
            return { t: t, r: r, s: t.seeders || 0, res: this.resScore(t.resolution) }
        })
        arr.sort((a, b) => (a.r - b.r) || (b.s - a.s) || (b.res - a.res))

        const out = arr.map((x) => x.t)
        if (out.length) out[0].isBestRelease = true
        return out
    }

    private buildCtx(media: any, requestedEp: number): EpisodeCtx {
        const offset = media.absoluteSeasonOffset || 0
        return {
            requestedEp: requestedEp,
            offset: offset,
            epCount: media.episodeCount || -1,
            isFirstSeason: offset === 0,
        }
    }

    private finalize(items: NyaaItem[], ctx: EpisodeCtx): AnimeTorrent[] {
        const seen: Record<string, boolean> = {}
        const out: AnimeTorrent[] = []
        for (const it of items) {
            const key = it.infoHash || it.guid || it.link
            if (!key || seen[key]) continue
            seen[key] = true
            out.push(this.mapItem(it, ctx))
        }
        return out
    }

    private uniqueTitles(list: string[], limit: number): string[] {
        const seen: Record<string, boolean> = {}
        const out: string[] = []
        for (const s of list) {
            const v = (s || "").trim()
            if (!v) continue
            const k = v.toLowerCase()
            if (seen[k]) continue
            seen[k] = true
            out.push(v)
            if (out.length >= limit) break
        }
        return out
    }

    // ---- Interface ---------------------------------------------------------

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const media: any = opts.media || {}
        const query = (opts.query || media.romajiTitle || (media.englishTitle || "") || "").trim()
        if (!query) return []
        const ctx = this.buildCtx(media, 0)
        const items = this.filterItems(await this.query(query), ctx)
        return this.rankByLanguage(this.finalize(items, ctx))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const media: any = opts.media || {}
        const userQuery = (opts.query || "").trim()
        const ep = (!opts.batch && opts.episodeNumber && opts.episodeNumber > 0) ? opts.episodeNumber : 0
        const ctx = this.buildCtx(media, ep)

        // Title variants (romaji + english first, then Seanime's cleaned variants).
        // We do NOT inject a season number into the query — season is handled by
        // filtering, not by search text.
        const candidates: string[] = []
        if (media.romajiTitle) candidates.push(media.romajiTitle)
        if (media.englishTitle) candidates.push(media.englishTitle)
        if (media.synonyms) for (const s of media.synonyms) if (s) candidates.push(s)

        let builtTitles: string[] = []
        try {
            const built = $scannerUtils.buildSmartSearchTitles(candidates.length ? candidates : [""])
            if (built && built.titles) builtTitles = built.titles
        } catch (e) { /* fall back below */ }

        const bases = userQuery
            ? [userQuery]
            : this.uniqueTitles([media.romajiTitle || "", media.englishTitle || ""].concat(builtTitles), 3)
        if (!bases.length) return []

        // Query set: plain title (batches/packs/all episodes) + episode-targeted
        // queries covering seasonal AND absolute numbering, padded/unpadded.
        const queries: string[] = []
        const seenQ: Record<string, boolean> = {}
        const addQ = (q: string) => {
            const v = (q || "").trim()
            if (!v) return
            const k = v.toLowerCase()
            if (seenQ[k]) return
            seenQ[k] = true
            queries.push(v)
        }
        const addEp = (base: string, n: number) => {
            if (n <= 0) return
            addQ(base + " " + this.pad2(n))
            if (n < 10) addQ(base + " " + n)
        }

        for (let i = 0; i < bases.length; i++) {
            const b = bases[i]
            addQ(b)
            if (ep > 0) {
                addEp(b, ep)
                if (ctx.offset > 0) addEp(b, ep + ctx.offset)
            }
        }

        let collected: NyaaItem[] = []
        const capped = queries.slice(0, 10)
        for (let i = 0; i < capped.length; i++) {
            collected = collected.concat(await this.query(capped[i]))
        }

        const filtered = this.filterItems(collected, ctx)
        return this.rankByLanguage(this.finalize(filtered, ctx))
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        const items = await this.query("", { sort: "date" })
        const ctx: EpisodeCtx = { requestedEp: 0, offset: 0, epCount: -1, isFirstSeason: false }
        return this.finalize(items, ctx)
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        return this.buildMagnet(torrent.infoHash, torrent.name)
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
}
