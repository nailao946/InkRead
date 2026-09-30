# InkRead (墨读)

[中文](./README.md) | **English**

A **local-first** intensive English reading tool for desktop and mobile. It colours every word in a
text according to *your own* vocabulary — **unknown in red, learning in blue, known in black**
(the three colours are customisable). Tap a word to look it up instantly, with local TTS
pronunciation and one-click Cambridge Dictionary lookup.

Everything runs on your machine: no account, no cloud, no telemetry.

## Repository layout (two front-ends, one codebase)

```
READ/
├── web/          Web version (HTML/CSS/JS — works in any browser, phone or desktop)
│   ├── index.html
│   ├── css/ js/ lib/ dict/ tests/ tools/
│   └── start-server.bat
├── wpf/          WPF desktop app (WPF + WebView2 shell — see wpf/构建说明.md)
│   ├── InkRead.slnx / InkRead.sln   (VS 2022 17.10+ uses .slnx, older uses .sln)
│   └── bin/Release/net8.0-windows/InkRead.exe  (pre-built, double-click to run)
├── THEMES.md     Theme spec + maintenance contract (shared by all front-ends)
├── HANDOVER.md   Architecture / handover notes (for developers and AI agents)
├── README.md     Chinese README
└── README.en.md  This file
```

## Highlights (v0.5)

- **5 themes**, one-click switching (spec: [THEMES.md](./THEMES.md))
- **Vocabulary**: import TXT / CSV / Excel (.xls/.xlsx) / clipboard; export to .xlsx; three-state
  marking (unknown / learning / known); batch operations; search & filter; backup
- **Shelf**: **group chips + group frames + cover grid** (WeChat-Reading style)
  - **Chip bar**: `All / Ungrouped / each group / + New group` — tap any chip to enter it
  - **Group frames**: in the *All* view every group gets its own row — a frame header with
    **icon + name + book count** and a horizontally scrolling row of covers; tap the header to open it
  - **Cover grid**: opening a group shows a responsive cover grid (badge, progress bar and percentage per
    cell); “⋯” or right-click for details
  - **Group icons**: pick one of 14 presets in the create/edit dialog, or “none”
  - **Aligned information**: card rows have fixed heights (title exactly two lines, author and meta one
    line each), so progress bars and percentages line up no matter how long the titles are
  - **Reading progress**: thick rounded gradient bar (grey unread, amber reading, green finished) + percentage
  - **Details dialog**: cover, **“Continue reading” right under the progress bar**, a **segmented control**
    for the reading state (unread / reading / finished), a compact group selector, total reading time,
    last-read / added / finished timestamps
  - **Vocabulary difficulty (graded reading)**: counts **unknown / learning / known** words plus token
    coverage, rates the book (Easy ≥98%, Ideal i+1 95–98%, Challenging 90–95%, Frustrating <90%) with
    advice, and lists the **top 12 high-frequency unknown words** (one click to add them all)
  - **🔍 Find a book**: type a title/author and it opens that site's own search results
    (Project Gutenberg, Standard Ebooks, Open Library, Douban Books); a “custom source” field accepts any
    URL template with `{q}` as the keyword placeholder
- **Reader**: EPUB / MOBI / TXT / PDF (including inline images); three-colour highlighting plus
  lemmatisation; tap-a-word popup with pronunciation, dictionary meaning and online translation
- **MOBI parsing (deep fixes in v0.5)**: PalmDOC *distance* back-referencing, backward-encoded
  trailing entries and multi-byte overlap — three spec-level bugs fixed. Real Kindle books (e.g.
  *Boundless*) import completely: title / author / cover / 89-chapter TOC / inline images / 680k chars
- **Offline dictionary**: bundled ECDICT (~400k words, 25.7 MB shards). Instant phonetics, part of
  speech and Chinese definitions. Works even when `index.html` is opened via `file://` — shards are
  loaded with `<script>` tags, so no fetch/HTTP is required
- **Reading modes**: continuous scroll or page-flip (WeChat-Reading style vertical pagination with
  click / keyboard / swipe navigation); floating TOC that can be pinned to a sidebar
- **Typography**: font size / line height / family adjustable live; reading progress bar that
  remembers position per mode
- **Read-aloud**: sentence-level queue with the current paragraph highlighted; optional auto-pronounce
  when tapping a word
- **Translation** (works on both front-ends):
  - 6 official APIs: Youdao, Baidu, **Tencent Cloud TMT, Alibaba Cloud MT, Huawei Cloud MT, Volcano
    Engine** (each with its own signature scheme: TC3-HMAC-SHA256 / RPC HMAC-SHA1 /
    SDK-HMAC-SHA256 / HMAC-SHA256-v4)
  - 3 free built-ins (no key needed): MyMemory (reachable from mainland China), Google, Bing
  - Auto mode tries configured official APIs in order, then falls back to MyMemory
  - Collapsible provider cards with Save / Test buttons and status badges; in-page help for where to
    obtain each key
  - **Auto-translate on word tap** (can be disabled; results are cached in memory)
  - **Local forwarding (essential)**: browsers block direct calls to those APIs with CORS. The
    desktop app ships a forwarder; the web version gets one by launching `web/start-server.bat`
    (`tools/serve.py`). The front-end probes `/__proxy` and routes through it automatically, so the
    **web version can use official APIs too**
  - Proxy support (desktop): `http://` and `socks5://` for Google/Bing
- **Per-article word list** and three-colour statistics
- **PWA**: `manifest.json` + service worker (network-first), installable on desktop/mobile home screen
- **Demo article**: `index.html?demo=1`

## Running the web version

- **Simplest**: double-click `web/index.html`. TXT / EPUB / MOBI import and offline dictionary lookups
  all work.
- **To use official translation APIs**: double-click `web/start-server.bat` (local forwarder that
  bypasses browser CORS) or run `python web/tools/serve.py [port]`.
- **PDF import** also needs this HTTP server (the PDF parsing worker requires it).
- **Quick tour**: open `web/index.html?demo=1`.

## Running the desktop app (WPF)

- **No Visual Studio needed**: double-click `wpf/bin/Release/net8.0-windows/InkRead.exe`.
- **Self-contained**: all front-end assets (including the 51 MB dictionary shards) are embedded into
  `InkRead.dll` at build time, so no `web/` folder or external server is required at runtime. An
  embedded HTTP server on `127.0.0.1` serves them to WebView2 (giving standard behaviour for service
  workers, IndexedDB, the PDF worker and TTS) and also exposes `/__proxy` for translation APIs.
- **Building**: open `wpf/InkRead.slnx` in VS 2022 (17.10+) or run
  `dotnet build wpf/InkRead.slnx -c Release`; publish a single file with
  `dotnet publish wpf/InkRead.slnx -c Release -p:PublishSingleFile=true`.
- **Live front-end editing**: set the `INKREAD_WEB_DIR` environment variable to the `web` folder and
  the shell will prefer the files on disk.
- Vocabulary/book data lives in `%LOCALAPPDATA%\InkRead\WebView2` and survives upgrades.
- **Startup log** (for blank-window issues): `InkRead.log` next to the exe, falling back to
  `%LOCALAPPDATA%\InkRead\inkread-desktop.log`.

## Supported formats and limitations

| Format | Status |
|---|---|
| TXT | ✅ Auto-detects UTF-8 / UTF-16 / GBK·GB18030 — no mojibake |
| EPUB | ✅ Standard EPUB (ZIP + OPF + XHTML) |
| MOBI | ✅ Uncompressed / PalmDOC LZ77 (including backward trailing entries and multi-byte overlap). ❌ DRM and HUFF/CDIC (AZW3/KF8) are reported with a clear message (convert with Calibre) |
| PDF | ✅ PDFs with a text layer. ❌ Scanned image-only PDFs are reported clearly (OCR not supported yet) |

## Data and privacy

All data (vocabulary, shelf, settings, API keys) stays **on your machine**. Nothing is uploaded.

### Automatic on-disk archive

The desktop app and the web version launched via `start-server.bat` write your progress to real files
(default: `Documents\InkRead`, configurable under *Settings → Storage & Archive*):

| File | Contents |
|---|---|
| `vocab.csv` | All words with state (UTF-8 BOM — opens directly in Excel / WPS) |
| `vocab.json` | Same data, lossless for the app |
| `books/<title>.json` | Full text and reading progress of each imported book |
| `settings.json` | All settings + API keys (**copy this single file to move to another machine**) |

Writes happen when you mark a word, run batch operations, import a book or change settings
(debounced 0.7 s), plus a final flush on exit. On startup, if local storage is empty, the archive is
restored automatically.

## Tests

```
node tests/test-importers.mjs   # 20/20 TXT encodings, EPUB, MOBI, word lists, lemmatisation, signatures
node tests/test-bridge.mjs      # 15/15 desktop API bridge (interception, bodies, headers, status, errors, concurrency)
node tests/test-engines.mjs     # 21/21 six engines, dispatch, auto chain, HMAC vs Node crypto, multi-line rendering
node tests/test-store.mjs       # 18/18 on-disk archive against a real server (CSV format, traversal guard, restore)
node tests/test-dict.mjs        # 8/8  dictionary shards, lookup, lemmatisation, file:// fallback
node tests/test-shelf.mjs       # 46/46 reading state, groups + icons, reading time, throttling, group frames, difficulty
node tests/test-web.mjs         # 18/18 web completeness (assets + MIME, key scripts, proxy/archive live, page structure)
```

See [HANDOVER.md](./HANDOVER.md) for architecture, module responsibilities, data model and handover notes.
