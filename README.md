# Career Orbit

A free, self-hosted job-matching agent for senior product roles. Every day it pulls PM and product owner roles in Hyderabad from public job APIs, scores each one against your profile with an LLM, and publishes the matches to a personal dashboard — along with a daily intelligence brief covering market trends, certifications in demand, and industry news.

No servers, no paid hosting. Runs entirely on GitHub Actions and GitHub Pages.

```
GitHub Actions (cron 9 PM IST)
  └─> agent.mjs
        ├─ fetch   — JSearch + Adzuna + optional Greenhouse/Lever
        ├─ filter  — free keyword + location pre-filter
        ├─ score   — Gemini (Groq fallback) → match score, verdict, pros/cons
        ├─ dedup   — seen.json rolling window
        └─ write   — data/results.json + data/insights.json
              └─> index.html (GitHub Pages dashboard)
```

## What it does

- **Job sourcing** — JSearch (aggregates LinkedIn, Glassdoor, Indeed via Google for Jobs) and Adzuna. Greenhouse and Lever boards are an optional targeted layer for specific companies.
- **Free pre-filter** — keyword and location rules drop obvious misses before any LLM call, keeping scoring costs near zero.
- **LLM scoring** — Gemini (`gemini-2.5-flash`) compares each surviving job to your profile and returns a 0–100 match score, a one-line verdict, pros/cons, and a seniority-fit flag. If Gemini hits its free-tier quota, Groq (Llama 3.3 70B) steps in automatically as a fallback.
- **Intelligence brief** — a separate daily Gemini call generates market trends, certifications in demand, and industry news tailored to your profile. Cached per day so it only costs one call.
- **Dedup + rolling window** — each job is scored once and stays on the board for `retentionDays` days, then drops off automatically.
- **Cadence** — the workflow fires every day at 9 PM IST; `runEveryNDays` in config controls how often the agent actually acts.

## Setup (~20 minutes)

### 1. Create the repo

Push these files to a new **public** GitHub repo. Public is required for free GitHub Pages. Your personal profile data never enters the repo — it lives in a secret (see step 3).

### 2. Get four free API keys

| Key | Where |
|---|---|
| **Gemini** | aistudio.google.com → Get API key |
| **Adzuna** | developer.adzuna.com → register → app_id + app_key |
| **JSearch** | rapidapi.com → search "JSearch" → free Basic plan → copy RapidAPI key |
| **Groq** | console.groq.com → API Keys → Create key (fallback LLM, free) |

### 3. Add repo secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `GEMINI_MODEL` | `gemini-2.5-flash` (Gemini 2.0 shuts down June 2026) |
| `ADZUNA_APP_ID` | your Adzuna app id |
| `ADZUNA_APP_KEY` | your Adzuna app key |
| `JSEARCH_API_KEY` | your RapidAPI key |
| `GROQ_API_KEY` | your Groq key (fallback — optional but recommended) |
| `PROFILE_JSON` | edit `profile.example.json`, paste the entire JSON here |

`PROFILE_JSON` keeps your CV and preferences out of the public repo. Locally you can copy it to `profile.json` instead — it is gitignored.

### 4. Set workflow permissions

Repo → Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save. Without this the agent cannot commit results back to the repo.

### 5. Enable Pages

Repo → Settings → Pages → Source: **Deploy from branch** → branch: `main`, folder: `/ (root)` → Save. Your dashboard goes live at `https://<you>.github.io/<repo>/`.

### 6. First run

Repo → Actions → **Job Radar** → Run workflow → tick **force** → Run workflow. The agent scans, commits `data/results.json` and `data/insights.json`, Pages redeploys in ~60 seconds, and the dashboard fills in.

## Tuning — `config.json`

| Key | What it does | Default |
|---|---|---|
| `matching.minScore` | minimum score to appear on the board | `60` |
| `matching.retentionDays` | days a match stays visible | `10` |
| `matching.titleKeywords` | job titles that pass the pre-filter | see file |
| `matching.titleExclude` | titles that are always dropped | see file |
| `matching.locationKeywords` | locations that pass the pre-filter | `hyderabad, remote, india…` |
| `sources.jsearch.queries` | search queries sent to JSearch | see file |
| `sources.adzuna.queries` | search queries sent to Adzuna | see file |
| `sources.greenhouse` | company slugs from Greenhouse boards | `[]` |
| `sources.lever` | company slugs from Lever boards | `[]` |
| `runEveryNDays` | how often the agent actually scans | `1` |

To add a targeted company: find their careers URL (e.g. `jobs.lever.co/acme`) and add `"acme"` to `sources.lever`. Bad slugs are skipped gracefully.

## Cost

Everything runs on free tiers:

| Service | Free limit | Usage per run |
|---|---|---|
| GitHub Actions | unlimited (public repo) | ~3 min |
| GitHub Pages | unlimited (public repo) | static serving |
| Gemini API | daily request + token quota | 1 insights call + N scoring calls |
| Groq API | ~14,400 req/day, 12k TPM | fallback only |
| JSearch | ~200 req/month | 3 queries |
| Adzuna | ~1,000 req/month | 3 queries |

The pre-filter keeps LLM calls to a manageable number per run. Running daily stays comfortably inside all free tiers under normal conditions.

## Troubleshooting

**0 matches, run succeeds in under 30s** — the cadence gate skipped the run (already ran today). Use the **force** checkbox when triggering manually.

**Gemini HTTP 429 on every job** — the free-tier daily quota is exhausted. Add `GEMINI_MODEL` secret set to `gemini-2.5-flash` if not already set. Groq will handle the fallback automatically if `GROQ_API_KEY` is set.

**`Cannot find module scripts/agent.mjs`** — the `scripts/` subfolder wasn't pushed. Create the file in GitHub: Code tab → Add file → Create new file → type `scripts/agent.mjs` → paste content → commit.

**Pages not updating after a successful run** — wait 60–90 seconds and hard refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`). Pages rebuilds asynchronously after each commit.

**Workflow permission error on commit step** — Settings → Actions → General → Workflow permissions → Read and write → Save.

## Known limits

- No Naukri coverage — no public API exists. JSearch and Adzuna are the workaround for India coverage.
- Jobs open longer than `retentionDays` drop off the board and won't resurface unless `seen.json` is deleted.
- GitHub's scheduled runs can lag by 10–30 minutes under load — acceptable for a daily digest.
- The intelligence brief uses Gemini's training knowledge, not live web search. News items reflect recent developments as of the model's cutoff, not today's headlines.

## V2 ideas

- Company culture check — web-search synthesis on each matched employer
- Email digest delivered to your inbox alongside the dashboard
- Re-score long-open roles so they don't silently age off
- Dismiss / Applied state per job stored in the dashboard
- Live news via Gemini's grounded search tool
