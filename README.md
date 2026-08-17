# Career Orbit

A free, self-hosted visa-sponsored job-matching portal for senior PM / PO roles. Every day it searches across the UK, Singapore, Germany, Australia, USA and Hyderabad, extracts sponsorship signals from full job descriptions, scores each role against your profile with an LLM, and publishes matches to a personal dashboard with visa intel, market trends, and certifications in demand.

No servers, no paid hosting. Runs entirely on GitHub Actions and GitHub Pages.

```
GitHub Actions (cron 9 PM IST)
  └─> scripts/agent.mjs
        ├─ fetch    — JSearch + Adzuna (6 countries) + MyCareersFuture (SG govt)
        │            + optional Greenhouse / Lever targeted boards
        ├─ pre-filter — title / location / no-sponsorship keyword drop
        ├─ quick sponsor screen — drop explicit "no sponsorship" before LLM
        ├─ score   — Gemini (Groq fallback):
        │             match score · seniority fit · sponsorshipSignal
        │             sponsorshipEvidence · visaType · pros / cons
        ├─ dedup   — data/seen.json rolling window
        └─ write   — data/results.json + data/insights.json
              └─> index.html (GitHub Pages dashboard)
```

## What it does

- **Multi-country sourcing** — Adzuna covers UK, Singapore, Germany, Australia, USA and India with the same API key. JSearch aggregates LinkedIn / Glassdoor / Indeed globally. MyCareersFuture covers Singapore's government job portal (free, no key needed).
- **Sponsorship signal extraction** — the agent reads full job descriptions and extracts a four-level signal: `confirmed` (JD explicitly offers visa sponsorship), `likely` (relocation support, known sponsor, global talent language), `unclear`, or `no` (explicit refusal). Roles with `no` or `unclear` are dropped before they hit the board.
- **LLM scoring** — Gemini (`gemini-2.5-flash`) scores each job 0–100 against your profile, returns pros/cons, seniority fit, and visa type. Groq (Llama 3.3 70B) is the automatic fallback if Gemini hits quota.
- **Visa Intel brief** — daily Gemini call generates country-by-country visa trends, known sponsors, and certifications useful for visa applications. Cached per day.
- **Dashboard** — country filter tabs, sponsorship confidence badge on every card, confirmed-first sort, Visa Intel column alongside Market Trends and Industry News.
- **Dedup + rolling window** — each job scored once, stays on board for `retentionDays` days.

## Setup (~25 minutes)

### 1. Create the repo

Push all files to a new **public** GitHub repo. Public is required for free GitHub Pages.

### 2. Get your API keys (all free)

| Key | Where |
|---|---|
| **Gemini** | aistudio.google.com → Get API key |
| **Adzuna** | developer.adzuna.com → register → `app_id` + `app_key` |
| **JSearch** | rapidapi.com → search "JSearch" → free Basic plan → copy RapidAPI key |
| **Groq** | console.groq.com → API Keys → Create key (fallback LLM, free) |

MyCareersFuture (Singapore) requires no key.

### 3. Add repo secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `GROQ_API_KEY` | your Groq key |
| `ADZUNA_APP_ID` | your Adzuna app id |
| `ADZUNA_APP_KEY` | your Adzuna app key |
| `JSEARCH_API_KEY` | your RapidAPI key |
| `PROFILE_JSON` | edit `profile.example.json`, paste the entire JSON here |

`PROFILE_JSON` keeps your CV and visa details out of the public repo. Locally you can copy it to `profile.json` instead — it is gitignored.

### 4. Set workflow permissions

Repo → Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.

### 5. Enable Pages

Repo → Settings → Pages → Source: **Deploy from branch** → branch: `main`, folder: `/ (root)` → Save.

Your dashboard goes live at `https://<you>.github.io/<repo>/`.

### 6. First run

Repo → Actions → **Job Radar** → Run workflow → tick **force** → Run workflow.

The agent scans, commits `data/results.json` and `data/insights.json`, Pages redeploys in ~60 seconds, and the dashboard fills in.

## Tuning — `config.json`

| Key | What it does | Default |
|---|---|---|
| `matching.minScore` | minimum LLM score to appear on board | `60` |
| `matching.retentionDays` | days a match stays visible | `10` |
| `matching.minSponsorshipSignal` | which signals pass (`confirmed`, `likely`, `local`) | see file |
| `matching.titleKeywords` | job titles that pass pre-filter | see file |
| `matching.titleExclude` | titles always dropped | see file |
| `sources.adzuna.countries` | array of `{code, where, countryName}` | 6 countries |
| `sources.jsearch.queries` | search queries sent to JSearch | see file |
| `sources.mycareers.enabled` | Singapore government job portal | `true` |
| `sources.greenhouse` | company Greenhouse board slugs | `[]` |
| `sources.lever` | company Lever board slugs | `[]` |
| `runEveryNDays` | how often the agent actually scans | `1` |

### Adding a targeted company

Find their careers URL (e.g. `jobs.lever.co/revolut`) and add `"revolut"` to `sources.lever`. Same pattern for Greenhouse. Bad slugs are skipped gracefully.

## Cost

Everything runs on free tiers:

| Service | Free limit | Usage per run |
|---|---|---|
| GitHub Actions | unlimited (public repo) | ~4 min |
| GitHub Pages | unlimited (public repo) | static serving |
| Gemini API | daily token quota | 1 insights call + N scoring calls |
| Groq API | ~14,400 req/day | fallback only |
| JSearch | ~200 req/month | 6 queries |
| Adzuna | ~1,000 req/month | up to 18 queries (6 countries × 3 queries) |
| MyCareersFuture | unlimited (govt API) | 2 queries |

The pre-filter and quick sponsorship screen keep LLM calls manageable. Running daily is comfortably inside all free tiers under normal conditions.

## Troubleshooting

**0 matches, run under 30s** — cadence gate skipped the run. Use the **force** checkbox.

**Gemini 429 on every job** — daily quota exhausted. Ensure `GEMINI_MODEL` is set to `gemini-2.5-flash` and `GROQ_API_KEY` is set for automatic fallback.

**`Cannot find module scripts/agent.mjs`** — the `scripts/` folder wasn't pushed. Create it in GitHub: Code → Add file → `scripts/agent.mjs` → paste content → commit.

**Pages not updating** — wait 60–90s and hard refresh (`Cmd+Shift+R`).

**Workflow permission error on commit** — Settings → Actions → General → Workflow permissions → Read and write → Save.

**Adzuna returning 0 results for some countries** — some Adzuna country codes have limited coverage. Try adjusting the `where` field or broadening the query.

## Known limits

- No Naukri coverage (no public API). JSearch covers some India listings via Google for Jobs aggregation.
- Jobs open longer than `retentionDays` drop off. Delete `data/seen.json` to re-surface them.
- Sponsorship signal relies on JD text — companies that sponsor but don't mention it in JDs will show as `unclear` and be filtered. Add known-sponsor companies to Greenhouse/Lever for targeted sourcing.
- GitHub scheduled runs can lag 10–30 minutes under load.
- Visa Intel in the insights brief reflects the LLM's training knowledge, not live immigration policy. Always verify visa requirements directly with the relevant government or an immigration adviser.

## V2 ideas

- Dismiss / Applied / Interview tracking per card (stored in localStorage)
- Re-score stale roles before they expire
- Company culture synthesis via web search
- LinkedIn Easy Apply detection
- Known-sponsor company list seeded from public Home Office sponsor register (UK)
