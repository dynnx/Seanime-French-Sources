/// <reference path="./anime-torrent-provider.d.ts" />

/*
 * Nyaa (French) provider for Seanime
 * ----------------------------------
 * Sources anime torrents from Nyaa (https://nyaa.si) and keeps the French
 * releases (VOSTFR / VF / MULTI / FRENCH). Nyaa is public, so no passkey and
 * real magnet links.
 *
 * Language preference (auto-select):
 *   Each result is classified by track:
 *     - "vf"     : French dub  (VF / VFF / VFQ / TRUEFRENCH / FRENCH)
 *     - "multi"  : multi-audio (usually includes a French dub)
 *     - "vostfr" : French subs over Japanese audio (VOSTFR / VOST)
 *     - "other"  : French-tagged but unclassified
 *   Results are sorted by the configured preference (default: VF, then VOSTFR)
 *   and the top pick of the best available track is flagged isBestRelease, so
 *   Seanime's auto-select grabs a VF when one exists and falls back to VOSTFR
 *   otherwise. All results still appear in the list for manual picking.
 *
 * Season / episode alignment:
 *   Smart search asks Nyaa for BOTH the seasonal episode number Seanime wants
 *   and its absolute equivalent (episode + absoluteSeasonOffset), because many
 *   groups number episodes absolutely across seasons. Parsed absolute numbers
 *   are converted back to the season's numbering so they line up with Seanime.
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

interface EpisodeCtx {
    requestedEp: number   // seasonal episode Seanime asked for (0 = none)
    offset: number        // media.absoluteSeasonOffset
    epCount: number       // media.episodeCount (season length, -1 unknown)
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

// Any French / French-inclusive marker (used to keep or drop a release).
const FRENCH_RE = /(vostfr|vost\.fr|truefrench|\bfrench\b|\bmulti\b|\bvff?\b|\bvfq\b|\bvfi\b|\bvost\b|\[fr\]|\(fr\)|\bfr\b|\bfre\b|\bfra\b)/i

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

    // ---- Language classification + ranking ---------------------------------

    private isFrench(title: string): boolean {
        return FRENCH_RE.test(title || "")
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

    // Sort by language preference, then seeders, then resolution. Flags the top
    // pick of the best available track as the best release for auto-select.
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

    // Convert a parsed episode number to the season's numbering when the release
    // used absolute numbering across seasons.
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

    // ---- Result mapping ----------------------------------------------------

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

    private async query(text: string, opts?: { category?: string; sort?: string }): Promise<NyaaItem[]> {
        const url = this.buildRssUrl(text, opts)
        const xml = await this.fetchRss(url)
        let items = this.parseRss(xml)
        if (this.getConfig().frenchOnly) {
            items = items.filter((it) => this.isFrench(it.title))
        }
        return items
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
        const items = await this.query(query)
        const ctx: EpisodeCtx = { requestedEp: 0, offset: media.absoluteSeasonOffset || 0, epCount: media.episodeCount || -1 }
        return this.rankByLanguage(this.finalize(items, ctx))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const media: any = opts.media || {}
        const offset = media.absoluteSeasonOffset || 0
        const epCount = media.episodeCount || -1
        const userQuery = (opts.query || "").trim()
        const ep = (!opts.batch && opts.episodeNumber && opts.episodeNumber > 0) ? opts.episodeNumber : 0

        // Title variants + detected season.
        const candidates: string[] = []
        if (media.romajiTitle) candidates.push(media.romajiTitle)
        if (media.englishTitle) candidates.push(media.englishTitle)
        if (media.synonyms) for (const s of media.synonyms) if (s) candidates.push(s)

        let builtTitles: string[] = []
        let season = -1
        try {
            const built = $scannerUtils.buildSmartSearchTitles(candidates.length ? candidates : [""])
            if (built && built.titles) builtTitles = built.titles
            if (built) season = built.season
        } catch (e) { /* fall back below */ }

        const bases = userQuery
            ? [userQuery]
            : this.uniqueTitles(builtTitles.concat([media.romajiTitle || "", media.englishTitle || ""]), 2)
        if (!bases.length) return []

        // Build a deduped query set. Episode-targeted queries cover BOTH the
        // seasonal number and the absolute number (ep + offset), padded/unpadded.
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
            addQ(b)                                   // plain: batches, season packs, all episodes
            if (!userQuery && season > 1) addQ(b + " S" + this.pad2(season))
            if (ep > 0) {
                addEp(b, ep)                          // seasonal numbering
                if (offset > 0) addEp(b, ep + offset) // absolute numbering
            }
        }

        let collected: NyaaItem[] = []
        const capped = queries.slice(0, 10)
        for (let i = 0; i < capped.length; i++) {
            collected = collected.concat(await this.query(capped[i]))
        }

        const ctx: EpisodeCtx = { requestedEp: ep, offset: offset, epCount: epCount }
        return this.rankByLanguage(this.finalize(collected, ctx))
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        const items = await this.query("", { sort: "date" })
        const ctx: EpisodeCtx = { requestedEp: 0, offset: 0, epCount: -1 }
        return this.finalize(items, ctx)   // keep chronological, no language re-sort
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        return this.buildMagnet(torrent.infoHash, torrent.name)
    }
}
