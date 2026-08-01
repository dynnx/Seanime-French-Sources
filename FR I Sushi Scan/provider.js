/// <reference path="./manga-provider.d.ts" />
/**
 * Seanime manga provider — SushiScan (French VF/VOSTFR scans).
 * Site: https://sushiscan.fr  (MangaThemesia / "mangareader" WordPress theme)
 *
 * The Seanime JS engine has no DOM parser, so all HTML is parsed with regex.
 * Reference behaviour cross-checked against the maintained Mihon/Tachiyomi
 * SushiScan extension (MangaThemesia base):
 *   - search:            GET /page/{n}?s={query}
 *   - manga page:        /catalogue/{slug}/         (chapter list)
 *   - chapter pages:     ts_reader.run({sources:[{images:[...]}]})  (primary)
 *                        <div id="readerarea"><img>                 (fallback)
 */
class Provider {
    constructor() {
        this.baseUrl = "https://sushiscan.fr";
        this.mangaDir = "/catalogue";
        this._attrCache = {};
    }

    baseUrl = "";
    mangaDir = "";

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    _headers() {
        return {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": this.baseUrl + this.mangaDir + "/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        };
    }

    // ------------------------------------------------------------------ search
    async search(opts) {
        const query = (opts && opts.query ? opts.query : "").trim();
        if (!query) return [];

        // Fast path: the theme's autocomplete returns a small JSON payload instead
        // of the full results page. Much less to download.
        let results = await this._searchAjax(query);

        // Fallback: full-page HTML search (used if autocomplete is off/empty).
        if (results.length === 0) {
            results = await this._searchHtml(
                `${this.baseUrl}/page/1?s=${encodeURIComponent(query)}`
            );
        }
        // Fallback: catalogue advanced-search "title" filter.
        if (results.length === 0) {
            results = await this._searchHtml(
                `${this.baseUrl}${this.mangaDir}/?title=${encodeURIComponent(query)}`
            );
        }

        return results;
    }

    async _searchAjax(query) {
        try {
            const h = this._headers();
            h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
            h["X-Requested-With"] = "XMLHttpRequest";
            h["Accept"] = "application/json, text/javascript, */*; q=0.01";
            const res = await fetch(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
                method: "POST",
                headers: h,
                body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
            });
            if (!res.ok) return [];
            const data = await res.json();
            const out = [];
            const seen = {};
            this._walkAjax(data, out, seen);
            return out;
        } catch (e) {
            return [];
        }
    }

    // The autocomplete JSON shape varies across theme versions, so walk the whole
    // structure and pick up anything that looks like a /catalogue/ series entry.
    _walkAjax(node, out, seen) {
        if (!node) return;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) this._walkAjax(node[i], out, seen);
            return;
        }
        if (typeof node === "object") {
            const link = node.post_link || node.url || node.link || node.permalink || "";
            const sm = /\/catalogue\/([^"\/?#]+)/i.exec(String(link));
            const title = node.post_title || node.title || node.name || "";
            if (sm && title && !seen[sm[1]]) {
                seen[sm[1]] = true;
                out.push({
                    id: sm[1],
                    title: this._decode(String(title)).trim(),
                    image: node.post_image || node.image || node.thumbnail || undefined,
                });
            }
            for (const k in node) this._walkAjax(node[k], out, seen);
        }
    }

    async _searchHtml(url) {
        try {
            const res = await fetch(url, { headers: this._headers() });
            if (!res.ok) return [];
            const html = await res.text();
            return this._parseSearchCards(html);
        } catch (e) {
            return [];
        }
    }

    _parseSearchCards(html) {
        // Primary: genuine result cards carry the ".bsx" wrapper (this is
        // MangaThemesia's own search selector). Anchoring to it excludes the
        // site-wide "Populaire" sidebar and the genre-filter / A-Z footer — whose
        // links also point at /catalogue/ — WITHOUT slicing the HTML. (Slicing was
        // fragile: those panels can render before the grid, which cut real results.)
        let out = this._collectCards(
            html,
            /class=["'][^"']*\bbsx\b[^"']*["'][\s\S]{0,500}?<a\s+href="(https?:\/\/[^"]*?\/catalogue\/([^"\/?#]+)\/?)"[^>]*?\stitle="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
        );
        // Safety net: if the markup ever differs, accept any /catalogue/ card anchor
        // so a page that clearly has results never comes back empty.
        if (out.length === 0) {
            out = this._collectCards(
                html,
                /<a\s+href="(https?:\/\/[^"]*?\/catalogue\/([^"\/?#]+)\/?)"[^>]*?\stitle="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
            );
        }
        return out;
    }

    _collectCards(html, re) {
        const results = [];
        const seen = {};
        let m;
        while ((m = re.exec(html)) !== null) {
            const slug = m[2];
            const title = this._decode(m[3]).trim();
            if (!title || seen[slug]) continue;
            seen[slug] = true;
            results.push({ id: slug, title: title, image: this._extractImg(m[4] || "") });
        }
        return results;
    }

    // --------------------------------------------------------------- chapters
    async findChapters(mangaId) {
        // mangaId is the series slug; rebuild the catalogue URL.
        const url = mangaId.indexOf("http") === 0
            ? mangaId
            : `${this.baseUrl}${this.mangaDir}/${mangaId}/`;
        try {
            const res = await fetch(url, { headers: this._headers() });
            if (!res.ok) return [];
            const html = await res.text();
            let chapters = this._parseChapters(html, true);
            // If scoping to #chapterlist yielded nothing, parse the whole document.
            if (chapters.length === 0) chapters = this._parseChapters(html, false);
            return chapters;
        } catch (e) {
            return [];
        }
    }

    _parseChapters(html, scoped) {
        // When scoped, limit to the #chapterlist block (trailing comments / related /
        // sidebar / footer trimmed) so long series parse fast. findChapters retries
        // unscoped when this returns nothing, so scoping can never cause a null.
        let region = html;
        if (scoped) {
            const start = html.search(/id=["']chapterlist["']/i);
            if (start !== -1) {
                region = html.slice(start);
                const end = region.search(
                    /id=["'](?:comments|similar|disqus)|class=["'][^"']*\b(?:wpop|serieslist|releases)\b|Filtre de recherche|az-lists|<footer\b|id=["']sidebar["']/i
                );
                if (end > 0) region = region.slice(0, end);
            }
        }

        const chapters = [];
        const seen = {};
        const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = liRe.exec(region)) !== null) {
            const inner = m[1];

            // Must look like a chapter row: has a "chapternum" label.
            const numSpan = inner.match(
                /class=["'][^"']*chapternum[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
            );

            // Pick the anchor that points at an actual chapter/volume URL.
            const anchors = inner.match(/<a\s+[^>]*href="([^"]+)"/gi) || [];
            let chapUrl = null;
            for (const a of anchors) {
                const href = (a.match(/href="([^"]+)"/i) || [])[1];
                if (href && /(?:chapitre|chapter|chapter-|tome|volume)-?[\d.]/i.test(href)) {
                    chapUrl = href;
                    break;
                }
            }
            if (!chapUrl && anchors.length) {
                chapUrl = (anchors[0].match(/href="([^"]+)"/i) || [])[1] || null;
            }
            if (!chapUrl) continue;
            if (!numSpan && !/(?:chapitre|chapter|tome|volume)-?[\d.]/i.test(chapUrl)) continue;
            if (seen[chapUrl]) continue;
            seen[chapUrl] = true;

            const num = this._chapterNumber(chapUrl, inner);
            const title = numSpan
                ? this._decode(this._stripTags(numSpan[1])).trim()
                : `Chapitre ${num}`;

            // Optional release date (shown by Seanime).
            const dateM = inner.match(
                /class=["'][^"']*chapterdate[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|time)>/i
            );

            const chap = {
                id: chapUrl,
                url: chapUrl,
                title: title || `Chapitre ${num}`,
                chapter: num,
                index: 0,
            };
            if (dateM) {
                const d = this._decode(this._stripTags(dateM[1])).trim();
                if (d) chap.updatedAt = d;
            }
            chapters.push(chap);
        }

        // Ascending order (0, 1, 2, ...) as Seanime expects.
        chapters.sort((a, b) => this._toFloat(a.chapter) - this._toFloat(b.chapter));
        for (let i = 0; i < chapters.length; i++) chapters[i].index = i;
        return chapters;
    }

    _chapterNumber(url, inner) {
        // Prefer the number embedded in the URL.
        let mm = url.match(/(?:chapitre|chapter|tome|volume)-([\d]+(?:[.\-][\d]+)?)/i);
        if (mm) return mm[1].replace(/-/g, ".");
        // Fall back to a data-num attribute on the <li>.
        mm = inner.match(/data-num=["']([\d.]+)["']/i);
        if (mm) return mm[1];
        // Last resort: first number in the label.
        mm = inner.match(/(\d+(?:\.\d+)?)/);
        return mm ? mm[1] : "0";
    }

    // ------------------------------------------------------------ chapter pages
    async findChapterPages(chapterId) {
        const url = chapterId.indexOf("http") === 0
            ? chapterId
            : `${this.baseUrl}/${chapterId}`;
        try {
            const res = await fetch(url, { headers: this._headers() });
            if (!res.ok) return [];
            const html = await res.text();

            let images = this._parseTsReader(html);
            if (images.length === 0) images = this._parseReaderArea(html);

            return images.map((imgUrl, i) => ({
                url: imgUrl,
                index: i,
                headers: { "Referer": url },
            }));
        } catch (e) {
            return [];
        }
    }

    _parseTsReader(html) {
        // ts_reader.run({...});  ->  sources[0].images
        const m = html.match(/ts_reader\.run\(\s*([\s\S]*?)\s*\)\s*;/);
        if (!m) return [];
        let jsonStr = m[1].trim();
        try {
            const data = JSON.parse(jsonStr);
            const sources = data && data.sources ? data.sources : [];
            if (!sources.length) return [];
            // Prefer the first source that actually has images.
            let imgs = [];
            for (const s of sources) {
                if (s && Array.isArray(s.images) && s.images.length) {
                    imgs = s.images;
                    break;
                }
            }
            return imgs
                .map((u) => (u || "").toString().replace(/^http:\/\//i, "https://"))
                .filter((u) => u.length > 0);
        } catch (e) {
            return [];
        }
    }

    _parseReaderArea(html) {
        const idx = html.search(/id=["']readerarea["']/i);
        let region = idx !== -1 ? html.slice(idx) : html;
        // Trim off the trailing UI (report box / share / footer) to avoid junk.
        const cut = region.search(
            /Signaler un probl|id=["'](?:reader-area-bottom|comments)["']|class=["'][^"']*chapter-nav|<footer/i
        );
        if (cut > 0) region = region.slice(0, cut);

        const pages = [];
        const seen = {};
        const tagRe = /<img\b[^>]*>/gi;
        let t;
        while ((t = tagRe.exec(region)) !== null) {
            const tag = t[0];
            const url =
                this._attr(tag, "data-lazy-src") ||
                this._attr(tag, "data-src") ||
                this._attr(tag, "data-cfsrc") ||
                this._attr(tag, "src");
            if (!url) continue;
            if (/^data:/i.test(url)) continue;
            if (/\/wp-content\/themes\//i.test(url)) continue; // theme assets (readerarea.svg…)
            if (/\.svg(?:$|\?)/i.test(url)) continue;
            if (seen[url]) continue;
            seen[url] = true;
            pages.push(url);
        }
        return pages;
    }

    // ------------------------------------------------------------------ helpers
    _extractImg(fragment) {
        const tag = (fragment.match(/<img\b[^>]*>/i) || [])[0];
        if (!tag) return undefined;
        return (
            this._attr(tag, "data-lazy-src") ||
            this._attr(tag, "data-src") ||
            this._attr(tag, "data-cfsrc") ||
            this._attr(tag, "src") ||
            undefined
        );
    }

    _attr(tag, name) {
        let re = this._attrCache[name];
        if (!re) {
            re = new RegExp(name + '=["\\\']([^"\\\']+)["\\\']', "i");
            this._attrCache[name] = re;
        }
        const m = tag.match(re);
        return m ? m[1] : null;
    }

    _stripTags(s) {
        return (s || "").replace(/<[^>]*>/g, "");
    }

    _toFloat(s) {
        const f = parseFloat(String(s).replace(/[^\d.]/g, ""));
        return isNaN(f) ? 0 : f;
    }

    _decode(s) {
        if (!s) return "";
        return s
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&#x27;/gi, "'")
            .replace(/&rsquo;|&#8217;|&#x2019;/gi, "\u2019")
            .replace(/&lsquo;|&#8216;/gi, "\u2018")
            .replace(/&ldquo;|&#8220;/gi, "\u201C")
            .replace(/&rdquo;|&#8221;/gi, "\u201D")
            .replace(/&hellip;|&#8230;/gi, "\u2026")
            .replace(/&nbsp;/gi, " ")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
            .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
    }
}
