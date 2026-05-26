#!/usr/bin/env node
/**
 * Job Radar - V1 agent
 *
 * Pipeline: fetch jobs from JSearch + Adzuna (+ optional Greenhouse/Lever)
 *  -> free keyword/location pre-filter
 *  -> dedup against everything seen before
 *  -> score the survivors with Gemini against the candidate profile
 *  -> merge into a rolling window and write data/results.json for the dashboard
 *
 * Runs daily via GitHub Actions; the cadence gate below enforces every-N-days.
 * No npm dependencies - Node 20+ native fetch only.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config.json');
const RESULTS_PATH = join(ROOT, 'data', 'results.json');
const SEEN_PATH = join(ROOT, 'data', 'seen.json');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ADZUNA_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_KEY = process.env.ADZUNA_APP_KEY;
const JSEARCH_KEY = process.env.JSEARCH_API_KEY;
const FORCE_RUN = process.env.FORCE_RUN === 'true';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

/** Strip HTML, decode common entities, collapse whitespace, cap length. */
function clean(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);
}

/** Stable short hash so the same posting is only ever scored once. */
function hashJob(j) {
  const s = `${j.company}|${j.title}|${j.url}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'j' + (h >>> 0).toString(36);
}

/** Load the matching profile: PROFILE_JSON secret > local profile.json > example. */
async function loadProfile() {
  if (process.env.PROFILE_JSON) {
    try {
      return JSON.parse(process.env.PROFILE_JSON);
    } catch {
      console.warn('  ! PROFILE_JSON is not valid JSON - falling back to file.');
    }
  }
  const local = await loadJson(join(ROOT, 'profile.json'), null);
  if (local) return local;
  return loadJson(join(ROOT, 'profile.example.json'), null);
}

// ---------------------------------------------------------------- sources

async function fetchJSearch(cfg, query) {
  if (!JSEARCH_KEY) return [];
  const params = new URLSearchParams({
    query, page: '1', num_pages: '1', date_posted: cfg.datePosted || 'week',
  });
  try {
    const res = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
      headers: {
        'X-RapidAPI-Key': JSEARCH_KEY,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((j) => ({
      company: j.employer_name || 'Unknown',
      title: j.job_title || '',
      location:
        [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') +
        (j.job_is_remote ? ' (remote)' : ''),
      url: j.job_apply_link,
      description: clean(j.job_description || ''),
      source: 'jsearch',
      postedAt: (j.job_posted_at_datetime_utc || '').slice(0, 10) || today(),
    }));
  } catch (e) {
    console.warn(`  ! jsearch "${query}": ${e.message}`);
    return [];
  }
}

async function fetchAdzuna(cfg, query) {
  if (!ADZUNA_ID || !ADZUNA_KEY) return [];
  const params = new URLSearchParams({
    app_id: ADZUNA_ID, app_key: ADZUNA_KEY,
    what: query, where: cfg.where || 'hyderabad',
    results_per_page: '50', 'content-type': 'application/json',
  });
  try {
    const res = await fetch(
      `https://api.adzuna.com/v1/api/jobs/${cfg.country}/search/1?${params}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.results || []).map((j) => ({
      company: j.company?.display_name || 'Unknown',
      title: j.title || '',
      location: j.location?.display_name || '',
      url: j.redirect_url,
      description: clean(j.description),
      source: 'adzuna',
      postedAt: (j.created || '').slice(0, 10) || today(),
    }));
  } catch (e) {
    console.warn(`  ! adzuna "${query}": ${e.message}`);
    return [];
  }
}

async function fetchGreenhouse(token) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).map((j) => ({
      company: token,
      title: j.title || '',
      location: j.location?.name || '',
      url: j.absolute_url,
      description: clean(j.content),
      source: 'greenhouse',
      postedAt: (j.updated_at || '').slice(0, 10) || today(),
    }));
  } catch (e) {
    console.warn(`  ! greenhouse/${token}: ${e.message}`);
    return [];
  }
}

async function fetchLever(company) {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${company}?mode=json`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data || []).map((j) => ({
      company,
      title: j.text || '',
      location: j.categories?.location || '',
      url: j.hostedUrl,
      description: clean(j.descriptionPlain || j.description || ''),
      source: 'lever',
      postedAt: j.createdAt
        ? new Date(j.createdAt).toISOString().slice(0, 10)
        : today(),
    }));
  } catch (e) {
    console.warn(`  ! lever/${company}: ${e.message}`);
    return [];
  }
}


// ----------------------------------------------------------- LLM caller with fallback

async function callLLM(prompt, temperature = 0.2) {
  // --- try Gemini first ---
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' },
        }),
      }
    );
    if (res.status === 429) {
      console.warn('  ~ Gemini quota hit, trying Groq fallback...');
      throw new Error('QUOTA');
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    if (!GROQ_KEY) throw new Error(`Gemini failed (${e.message}) and no GROQ_API_KEY set`);
    // --- Groq fallback ---
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: 1024,
      }),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }
}

// ----------------------------------------------------------- filter + score

function preFilter(job, m) {
  const title = (job.title || '').toLowerCase();
  const loc = (job.location || '').toLowerCase();
  if (!job.url || !job.title) return false;
  if (!m.titleKeywords.some((k) => title.includes(k))) return false;
  if (m.titleExclude.some((k) => title.includes(k))) return false;
  if (!m.locationKeywords.some((k) => loc.includes(k))) return false;
  return true;
}

async function scoreJob(job, profile, preferences) {
  const prompt = `You are screening one job posting for a specific candidate. Score the fit honestly.

CANDIDATE PROFILE
${JSON.stringify(profile, null, 2)}

WHAT THE CANDIDATE WANTS
${JSON.stringify(preferences, null, 2)}

JOB POSTING
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
Description: ${job.description}

Return ONLY a JSON object with this exact shape:
{
  "score": <integer 0-100: how well this job matches this candidate>,
  "seniorityFit": "<good | stretch | mismatch>",
  "verdict": "<one concise sentence on why it does or does not fit>",
  "pros": ["<short reason it fits>", "..."],
  "cons": ["<short reason it may not fit>", "..."]
}
Be strict. Reserve scores above 85 for genuinely strong matches. Penalise seniority
mismatches and roles that lack real end-to-end product ownership.`;

  return callLLM(prompt, 0.2);
}


// ----------------------------------------------------------- insights

async function fetchInsights(profile, preferences) {
  const INSIGHTS_PATH = join(ROOT, 'data', 'insights.json');
  const existing = await loadJson(INSIGHTS_PATH, null);
  if (existing && existing.generatedAt === today()) {
    console.log('  Insights already generated today, skipping.');
    return;
  }
  console.log('Generating market insights...');
  const prompt = `You are a product-management career advisor with deep knowledge of the Indian tech and fintech job market in 2026.

The candidate is:
- Role: ${JSON.stringify(profile.currentRole)}
- Domain: ${JSON.stringify(profile.domains)}
- Skills: ${JSON.stringify(profile.skills)}
- Seniority: ${JSON.stringify(profile.seniority)}
- Target roles: ${JSON.stringify(preferences.targetRoles)}

Return ONLY a JSON object with this exact shape (no markdown, no extra keys):
{
  "trends": [
    {
      "label": "<short trend name, max 5 words>",
      "detail": "<2 sentences: what is happening and why it matters for this candidate>"
    }
  ],
  "certifications": [
    {
      "name": "<certification name>",
      "provider": "<issuing body>",
      "why": "<1-2 sentences: why this cert is worth getting right now for this candidate>"
    }
  ],
  "news": [
    {
      "headline": "<short punchy headline, max 10 words>",
      "summary": "<2 sentences: what happened and why it matters for a senior product professional in fintech/AI>"
    }
  ]
}

Rules:
- trends: exactly 5 items. Focus on Indian market + global trends relevant to product management and AI product roles in 2026.
- certifications: exactly 5 items. Only include certifications that are genuinely valued by hiring managers in 2026. Mix AI, product, and domain-specific.
- news: exactly 4 items. Recent and relevant to product management, fintech, or AI product trends. Be specific - name real companies, products or regulations.
- Be specific and practical. No generic filler.`;

  let text;
  try {
    text = await callLLM(prompt, 0.3);
    // callLLM already returns parsed JSON, re-stringify so the catch block can parse
    text = JSON.stringify(text);
  } catch (e) {
    console.warn(`  ! insights call failed: ${e.message}`);
    return;
  }
  try {
    const insights = JSON.parse(text.replace(/```json|```/g, '').trim());
    await saveJson(INSIGHTS_PATH, { generatedAt: today(), ...insights });
    console.log('  Insights saved.');
  } catch (e) {
    console.warn(`  ! insights parse failed: ${e.message}`);
  }
}

// ------------------------------------------------------------------- main

async function main() {
  if (!GEMINI_KEY) {
    console.error('Missing GEMINI_API_KEY. Add it as a GitHub Actions secret.');
    process.exit(1);
  }
  const config = await loadJson(CONFIG_PATH, null);
  if (!config) {
    console.error('Cannot read config.json.');
    process.exit(1);
  }
  const { profile, preferences } = (await loadProfile()) || {};
  if (!profile) {
    console.error('No profile found (PROFILE_JSON secret / profile.json / example).');
    process.exit(1);
  }

  const results = await loadJson(RESULTS_PATH, { meta: {}, jobs: [] });
  const seen = await loadJson(SEEN_PATH, { hashes: [] });
  const seenSet = new Set(seen.hashes);

  // --- cadence gate: run daily, act every N days
  const last = results.meta?.lastRun;
  if (last && !FORCE_RUN) {
    const gap = daysBetween(last, today());
    if (gap < (config.runEveryNDays || 2)) {
      console.log(
        `Last run ${gap} day(s) ago; cadence is every ${config.runEveryNDays} days. Skipping.`
      );
      return;
    }
  }

  // --- 1. fetch
  console.log('Fetching jobs...');
  const raw = [];
  const s = config.sources;
  if (s.jsearch?.enabled)
    for (const q of s.jsearch.queries || [])
      raw.push(...(await fetchJSearch(s.jsearch, q)));
  if (s.adzuna?.enabled)
    for (const q of s.adzuna.queries || [])
      raw.push(...(await fetchAdzuna(s.adzuna, q)));
  for (const t of s.greenhouse || []) raw.push(...(await fetchGreenhouse(t)));
  for (const c of s.lever || []) raw.push(...(await fetchLever(c)));
  console.log(`  ${raw.length} jobs fetched.`);

  // --- 2. free pre-filter
  const filtered = raw.filter((j) => preFilter(j, config.matching));
  console.log(`  ${filtered.length} passed the pre-filter.`);

  // --- 3. dedup against history and within this batch
  const fresh = [];
  const batch = new Set();
  for (const j of filtered) {
    const h = hashJob(j);
    if (seenSet.has(h) || batch.has(h)) continue;
    batch.add(h);
    j.hash = h;
    fresh.push(j);
  }
  console.log(`  ${fresh.length} new jobs to score.`);

  // --- 4. score survivors with Gemini
  const newMatches = [];
  for (const j of fresh) {
    try {
      const r = await scoreJob(j, profile, preferences);
      seenSet.add(j.hash);
      const score = Math.round(r.score ?? 0);
      if (score >= config.matching.minScore) {
        newMatches.push({
          hash: j.hash, company: j.company, title: j.title,
          location: j.location, url: j.url, source: j.source,
          score, seniorityFit: r.seniorityFit || 'unknown',
          verdict: r.verdict || '', pros: r.pros || [], cons: r.cons || [],
          postedAt: j.postedAt, firstSeen: today(),
        });
        console.log(`  + ${score}  ${j.title} - ${j.company}`);
      } else {
        console.log(`  . ${score}  ${j.title} - ${j.company}`);
      }
    } catch (e) {
      console.warn(`  ! scoring failed (${j.title}): ${e.message}`);
    }
    await sleep(1500); // stay inside free-tier rate limits
  }

  // --- 5. merge into a rolling retention window
  const cutoff = config.matching.retentionDays;
  const kept = (results.jobs || []).filter(
    (j) => daysBetween(j.firstSeen, today()) < cutoff
  );
  const byHash = new Map();
  for (const j of [...kept, ...newMatches]) byHash.set(j.hash, j);
  const jobs = [...byHash.values()].sort((a, b) => b.score - a.score);

  // --- 6. write
  await saveJson(RESULTS_PATH, {
    meta: {
      lastRun: today(),
      generatedAt: new Date().toISOString(),
      scanned: raw.length,
      newlyScored: fresh.length,
      newMatches: newMatches.length,
      onBoard: jobs.length,
    },
    jobs,
  });
  await saveJson(SEEN_PATH, { hashes: [...seenSet].slice(-5000) });
  // --- 7. generate market insights
  await fetchInsights(profile, preferences);

  console.log(
    `Done. ${newMatches.length} new match(es); ${jobs.length} on the board.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
