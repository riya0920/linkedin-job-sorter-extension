# LinkedIn Job Sorter

A lightweight Chrome extension that makes LinkedIn job searches actually usable.
It runs on the LinkedIn **jobs search** page and adds a side panel that:

- **Sorts every result newest-first** (LinkedIn's own "most recent" is unreliable)
- **Splits reposts into their own tab** so recycled listings don't clog the fresh ones
- **Flags visa blockers** — a "No sponsor" tab for roles that say *US citizens only / clearance required / no sponsorship* (found by reading each job's full description)
- **Badges known H-1B sponsors** with their approval count *(optional — you supply the list, see below)*
- **Shows salary and location** on each card, and exports everything to CSV
- **Tracks seen / applied** so each scan surfaces only what's new
- **Reads job descriptions in-panel** — no need to open each posting
- Built-in **🧪 self-test** so you can verify the logic anytime

The number badge on each card is a **fit score** (keywords, recency, sponsor,
seniority) — it's shown for reference only; the list is always ordered newest-first.

## Install (unpacked)

1. **Download** this repo — green **Code ▸ Download ZIP**, then unzip. (Or `git clone`.)
2. Open **`chrome://extensions`** in Chrome (or any Chromium browser: Edge, Brave, Arc).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped **`linkedin-job-sorter-extension`** folder (the one containing `manifest.json`).
5. Go to a LinkedIn **job search** — a URL like `https://www.linkedin.com/jobs/search…` — and click the **⚡ Jobs** tab on the right, then **Scan**.

> It only activates on `linkedin.com/jobs/search*`. The "Jobs" home tab
> (`/jobs/collections/…`) won't trigger it — run an actual search first.

### Tips
- **🔁 Deep scan** opens each job to read its description — that's what finds reposts and citizens-only roles. Slower, but far more accurate.
- **Alt+J** hides / shows the panel.
- **⚙** opens filters (hide seen / applied / senior / agencies). **⋯** has export, self-test, and reset.

## Optional: enable the H-1B sponsor badge

`sponsors.js` ships empty, so the green **sponsor** badge is inactive by default.
To turn it on, replace `sponsors.js` with your own list built from public
[USCIS H-1B Employer Data Hub](https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub) data, in this shape:

```js
var LJS_SPONSOR_ROWS = [["STRIPE INC", 23], ["NVIDIA CORPORATION", 559]];
var LJS_SPONSOR_COMPANIES = LJS_SPONSOR_ROWS.map(function (r) { return r[0]; });
```

Everything else works without it.

## Privacy

Runs entirely in your browser. It reads only the LinkedIn job-search page you're
on, stores what it collects in your browser's local storage, and sends nothing
anywhere. The only permission it requests is `storage`.

## License

MIT — see [LICENSE](LICENSE).
