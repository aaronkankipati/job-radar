# Job Radar

A free, self-hosted job-matching agent. Every day it pulls product
roles in Hyderabad from public job APIs, scores each one against your CV
with an LLM, and publishes the matches to a dashboard.

No servers, no Cloudflare crons, no paid hosting. It runs on GitHub Actions
and GitHub Pages.

```
GitHub Actions (cron)  ->  agent.mjs  ->  data/results.json  ->  index.html (Pages)
                           fetch  filter  score  dedup
```

## What V1 does

- **Sources:** JSearch (Google for Jobs — includes LinkedIn/Glassdoor listings)
  and Adzuna. Greenhouse/Lever boards are an optional targeted layer.
- **Free pre-filter:** plain keyword + location rules drop obvious misses
  *before* any LLM call, so scoring stays cheap.
- **Scoring:** Gemini compares each surviving job to your profile and returns
  a 0–100 match score, a verdict, pros/cons and a seniority-fit flag.
- **Dedup + rolling window:** a job is scored once; matches stay on the board
  for `retentionDays`, then drop off.
- **Cadence:** the workflow runs daily; the agent only acts every `runEveryNDays`
  (default 2).

Not in V1: company-culture analysis. That's the planned V2 addition.

## Setup (about 15 minutes)

### 1. Create the repo
Push these files to a new **public** GitHub repo (public is required for free
Pages — your personal data is kept out of the repo, see step 3).

### 2. Get three free API keys
- **Gemini** — aistudio.google.com → "Get API key"
- **Adzuna** — developer.adzuna.com → register → app_id + app_key
- **JSearch** — rapidapi.com → search "JSearch" → subscribe to the free Basic plan → copy the RapidAPI key

### 3. Add repo secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `ADZUNA_APP_ID` | your Adzuna app id |
| `ADZUNA_APP_KEY` | your Adzuna app key |
| `JSEARCH_API_KEY` | your RapidAPI key |
| `PROFILE_JSON` | edit `profile.example.json`, paste the whole JSON here |

`PROFILE_JSON` keeps your CV/profile out of the public repo. (Locally you can
instead copy it to `profile.json`, which is gitignored.)

### 4. Enable Pages
Repo → Settings → Pages → Source: **Deploy from branch** → `main` / root.
Your dashboard goes live at `https://<you>.github.io/<repo>/`.

### 5. First run
Repo → Actions → **Job Radar** → Run workflow → tick **force** → Run.
It scans, commits `data/results.json`, and the dashboard fills in.

## Tuning — `config.json`

- `matching.minScore` — cutoff to appear on the board (default 65)
- `matching.retentionDays` — how long a match stays visible (default 10)
- `matching.titleKeywords` / `titleExclude` / `locationKeywords` — the free pre-filter
- `sources.jsearch.queries` / `adzuna.queries` — what gets searched
- `sources.greenhouse` / `lever` — optional: add company slugs from their
  careers-page URLs (e.g. a board at `jobs.lever.co/acme` → `"acme"`)
- `runEveryNDays` — cadence (default 2)

## Cost

Free, within these tier limits: Gemini and JSearch free tiers cap requests,
and Adzuna caps monthly calls. The pre-filter keeps LLM calls to a handful
per run, so an every-other-day cadence stays comfortably inside all three.
GitHub Actions and Pages are free for public repos.

## Known limits (V1)

- No Naukri coverage (no public API) — JSearch/Adzuna are the workaround.
- A role open longer than `retentionDays` drops off and won't resurface.
- GitHub's scheduled runs can be delayed under load — fine for a digest.
- If Gemini renames its free model, set a `GEMINI_MODEL` secret to override
  the default (`gemini-2.0-flash`).

## V2 ideas

- Company-culture check (web-search synthesis on each matched employer)
- Email digest instead of / alongside the dashboard
- Re-score long-open roles so they don't silently drop off
- A "dismiss" / "applied" state per job on the dashboard
