# Nyaa (French) — Seanime anime torrent provider

An anime torrent provider for [Seanime](https://seanime.rahim.app/) that pulls from **[Nyaa](https://nyaa.si)** and keeps the **French** releases (VOSTFR / VF / MULTI / FRENCH).

Built as the replacement for the YggTorrent provider after YggTorrent was hacked and permanently shut down in March 2026, taking the `yggapi.eu` proxy down with it. Two things make this version nicer to live with:

- **No passkey.** Nyaa is a *public* tracker, so there's nothing to configure — install it and search.
- **No proxy.** It talks to Nyaa directly and hands Seanime real **magnet links** (built from the info hash in Nyaa's RSS) plus the direct `.torrent` URL. Nothing fragile in the middle to go dark on you.

---

## Install

**Option A — try it fast (Playground)**
1. Seanime -> **Extensions** -> **Playground**.
2. Set type to **Anime Torrent Provider**, language **TypeScript**.
3. Paste the contents of `nyaa-fr.ts`, hit **Run**, and test a search (e.g. media *Kanojo, Okarishimasu*, method *smartSearch*).

**Option B — install for real (recommended)**
1. Put `nyaa-fr.json` somewhere Seanime can fetch it over HTTP — a GitHub repo or a Gist, using the **Raw** file URL.
2. Seanime -> **Extensions** -> **Add Extension** -> paste that raw URL.
3. It appears in your provider list. Open its settings if you want to change any defaults, then set it as a torrent provider for your library.

There's nothing you *have* to configure — the defaults are tuned for French anime out of the box.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| **French only** | On | Keeps only releases tagged VOSTFR / VF / MULTI / FRENCH. Turn off to see every language in the category. |
| **Audio preference** | Prefer VF, then VOSTFR | Which track auto-select grabs first. "Prefer VF" picks a French dub when one exists and falls back to VOSTFR; flip it to prefer French subs instead. All results still show for manual picking. |
| **Category** | Non-English-translated (`1_3`) | Nyaa category to search. `1_3` is where French subs live. "All anime" (`1_0`) casts the widest net and also catches French MULTI releases filed under other categories. "English-translated" (`1_2`) if you want English too. |
| **Sort** | Seeders | Seeders (best for streaming), Newest, Most downloaded, or Largest. |
| **Trusted only** | Off | Restricts to trusted uploaders. Cuts junk but drops *most* French results — leave off unless you're drowning in fakes. |
| **Base URL** | `https://nyaa.si` | Only change this if nyaa.si is blocked for you and you want to point at a mirror. |

---

## How it works / tips

- **Auto-select prefers VF, then VOSTFR** (configurable). Every result is classified — VF (French dub), MULTI (usually includes a dub), VOSTFR (French subs), or other — sorted by that preference, and the top pick of the best available track is flagged so Seanime grabs it automatically. The rest still appear for manual picking.
- **Season & episode matching.** The provider does **not** guess a season number and put it in the search box (that produced wrong-season results). It searches plain title variants (romaji + English) and filters results to the right season/episode instead: on a first season it drops releases tagged as a later season (`S02`+, "Season 2", "Saison 2") and single episodes numbered past the season length; on a sequel it keeps episodes within the season's range. For a specific episode it asks Nyaa for **both** the seasonal number and its absolute equivalent (`episode + absoluteSeasonOffset`), keeps only matches, and converts absolute numbers back to seasonal so they line up with Seanime. **Regular search** runs your query (or the media title) through the French filter.
- **If a show returns nothing**, it's almost always French availability, not a bug. Try, in order: switch **Category** to "All anime", or turn **French only** off to confirm the title exists on Nyaa at all. Popular/seasonal shows are reliably subbed in French; niche or older titles can be spotty.
- **Batches** (full seasons / `01-12` / "Complete") are detected and flagged so Seanime's batch toggle works.
- Sizes, dates, seeders/leechers, release group and resolution are parsed per result so Seanime's sorting and episode matching behave normally.

---

## Honest limitations

- **French depth.** Nyaa's French catalog is smaller than YggTorrent's was. You'll usually find VOSTFR for current and popular series; complete French coverage of long-running or obscure shows isn't guaranteed. For maximum French depth you'd need the decentralized UTOPEER/U2P route (self-hosted) — heavier setup; ask if you want to go there.
- **MULTI is not guaranteed French.** "MULTI" is treated as French-likely (French scene releases use it for multi-language), but a given MULTI release could pair English with a non-French track. Rare, but possible.
- **nyaa.si access.** If your network/ISP blocks nyaa.si, set a mirror in **Base URL**.

---

## Updating

Edit `nyaa-fr.ts`, bump `version` in `make_manifest_nyaa.js`, re-run `node make_manifest_nyaa.js` to regenerate `nyaa-fr.json`, and Seanime will pick up the new version from the same URL.
