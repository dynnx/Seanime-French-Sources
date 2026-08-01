# Seanime French Sources

![Seanime](https://img.shields.io/badge/Seanime-extensions-5A45FF) ![Language](https://img.shields.io/badge/audio-VF%20%2F%20VOSTFR-blue) ![Extensions](https://img.shields.io/badge/extensions-4-success)

French sources for [Seanime](https://seanime.rahim.app/) — streaming, torrents and manga, all tuned for **VF / VOSTFR** out of the box. No accounts, no passkeys.

| Extension | Type | What you get | Version |
|---|---|---|---|
| [Anime-Sama](#-anime-sama--streaming) | Online streaming | VOSTFR / VF episodes from anime-sama.to | 1.2.0 |
| [Nyaa (French)](#-nyaa-french--torrents) | Anime torrents | Nyaa filtered to French releases, real magnet links | 1.1.1 |
| [Torrent9](#-torrent9--torrents) | Anime torrents | French public torrents (OxTorrent successor) | 1.0.0 |
| [SushiScan](#-sushiscan--manga) | Manga | French scans from sushiscan.fr | 1.2.0 |

---

## Install

Same three steps for every extension:

1. Copy the extension's **manifest URL** below.
2. In Seanime: **Extensions → Add Extension** → paste the URL.
3. It appears in your provider list — pick it as a source for your library.

Everything works with default settings. TypeScript sources (`.ts`) can also be pasted into **Extensions → Playground** to test before installing.

---

## 📺 Anime-Sama — streaming

Stream French anime (VOSTFR / VF) from Anime-Sama. Search returns **one entry per season**, so episode numbers line up with Seanime. Playback resolves **vidmoly** (HLS) and **sibnet** (MP4) embeds.

```
https://raw.githubusercontent.com/dynnx/Seanime-French-Sources/main/FR%20l%20Anime%20Sama/anime-sama-fr.json
```

| Setting | Default | Notes |
|---|---|---|
| Base URL | `https://anime-sama.to` | Change only if the domain moves or is blocked. |

---

## 🧲 Nyaa (French) — torrents

Anime torrents from [Nyaa](https://nyaa.si), filtered to **VOSTFR / VF / MULTI / FRENCH** releases. Built as the replacement for the YggTorrent provider after YggTorrent shut down in March 2026 — and nicer to live with: Nyaa is a **public** tracker (no passkey) and the provider hands Seanime **real magnet links** built from the info hash, plus the direct `.torrent` URL. No proxy in the middle.

```
https://raw.githubusercontent.com/dynnx/Seanime-French-Sources/main/FR%20I%20Nyaa/nyaa-fr.json
```

| Setting | Default | Notes |
|---|---|---|
| French only | On | Turn off to see every language in the category. |
| Audio preference | Prefer VF, then VOSTFR | Which track auto-select grabs first; all results still show. |
| Category | Non-English-translated (`1_3`) | Where French subs live. "All anime" casts a wider net. |
| Sort | Seeders | Best for streaming. Also: newest, most downloaded, largest. |
| Trusted only | Off | Cuts junk but drops most French results — leave off. |
| Base URL | `https://nyaa.si` | Point at a mirror if nyaa.si is blocked for you. |

**How matching works:** the provider never guesses a season number into the query (that produced wrong-season results). It searches plain title variants and filters afterwards — dropping later-season releases on a first season, keeping in-range episodes on sequels, and querying both seasonal **and** absolute episode numbers so numbering always lines up. Batches (`01-12`, "Complete") are detected so Seanime's batch toggle works.

**No results?** It's almost always French availability, not a bug. Try category "All anime", then turn "French only" off to confirm the title exists on Nyaa at all.

---

## 🧲 Torrent9 — torrents

[Torrent9](https://www6.torrent9.to) (French public torrents, successor of the dead OxTorrent) as a second torrent source alongside Nyaa. No account needed. It's a general-purpose site, so it shines with a **custom search query** — auto-select accuracy is lower than Nyaa's.

```
https://raw.githubusercontent.com/dynnx/Seanime-French-Sources/main/FR%20I%20Torrent%209/torrent9.json
```

| Setting | Default | Notes |
|---|---|---|
| Base URL | `https://www6.torrent9.to` | Torrent9 mirrors rotate — set a working one if this dies. |

---

## 📖 SushiScan — manga

French manga / manhwa / manhua / BD scans from [sushiscan.fr](https://sushiscan.fr) — a large catalog that's usually the most up to date on ongoing series.

```
https://raw.githubusercontent.com/dynnx/Seanime-French-Sources/main/FR%20I%20Sushi%20Scan/manifest.json
```

> Only the `.fr` domain is supported — `sushiscan.net` sits behind Cloudflare bot protection and can't be scraped.

---

## Troubleshooting

- **A site stopped working** → its domain probably rotated. Set the new one in the extension's Base URL setting.
- **Nothing found for a show** → check French availability first (see the Nyaa tips above). Popular and seasonal shows are reliably covered; niche or older titles can be spotty.
- **Streaming episode won't play** → try the other server if the source offers one; embed hosts go down independently of the catalog site.

## Updating

Edit the `.ts` / `.js` source, bump `version` in the manifest, and Seanime picks up the new version from the same URL.

---

*These extensions host no content. They scrape publicly reachable third-party sites; availability and legality of those sites depend on your jurisdiction.*
