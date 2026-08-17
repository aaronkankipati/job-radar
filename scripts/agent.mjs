/**
 * Career Orbit — agent.mjs
 * Visa-aware job matching agent for senior PM / PO roles.
 * Runs on GitHub Actions. Writes data/results.json + data/insights.json.
 *
 * Pipeline:
 *   fetch → full-JD fetch → sponsorship pre-filter → LLM score → dedup → write
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createHash } from 'crypto';

// ─── Config & profile ────────────────────────────────────────────────────────

const CONFIG_PATH  = './config.json';
const DATA_DIR     = './data';
const RESULTS_PATH = path.join(DATA_DIR, 'results.json');
const INSIGHTS_PATH = path.join(DATA_DIR, 'insights.json');
const SEEN_PATH    = path.join(DATA_DIR, 'seen.json');

const config  = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const profile = JSON.parse(process.env.PROFILE_JSON || fs.readFileSync('./profile.json', 'utf8'));
const FORCE   = process.env.FORCE_RUN === 'true';

// API keys
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_KEY     = process.env.GROQ_API_KEY;
const JSEARCH_KEY  = process.env.JSEARCH_API_KEY;
const ADZUNA_ID    = process.env.ADZUNA_APP_ID;
const ADZUNA_KEY   = process.env.ADZUNA_APP_KEY;

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(...args) { console.log('[agent]', ...args); }

function hash(str) {
  return createHash('md5').update(str).digest('hex').slice(0, 12);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ─── Cadence gate ────────────────────────────────────────────────────────────

function shouldRun() {
  if (FORCE) { log('Force flag set — skipping cadence gate'); return true; }
  const runEvery = config.runEveryNDays || 1;
  if (!fs.existsSync(SEEN_PATH)) return true;
  const seen = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
  const last = seen.lastRun ? new Date(seen.lastRun) : new Date(0);
  const daysSince = (Date.now() - last.getTime()) / 86400000;
  if (daysSince < runEvery) {
    log(`Last run was ${daysSince.toFixed(1)} days ago — cadence gate (every ${runEvery}d). Skipping.`);
    return false;
  }
  return true;
}

// ─── Seen / dedup ────────────────────────────────────────────────────────────

function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return { lastRun: null, hashes: {} };
  return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
}

// ─── Fetch: JSearch ──────────────────────────────────────────────────────────

async function fetchJSearch() {
  if (!config.sources.jsearch?.enabled || !JSEARCH_KEY) return [];
  const jobs = [];
  for (const q of (config.sources.jsearch.queries || [])) {
    const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(q)}&num_pages=2&date_posted=${config.sources.jsearch.datePosted || 'week'}`;
    try {
      const res = await httpsGet(url, {
        'X-RapidAPI-Key': JSEARCH_KEY,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
      });
      if (res.status === 200 && res.body?.data) {
        jobs.push(...res.body.data.map(j => ({
          title: j.job_title,
          company: j.employer_name,
          location: j.job_city ? `${j.job_city}, ${j.job_country}` : (j.job_country || ''),
          url: j.job_apply_link || j.job_google_link,
          description: j.job_description || '',
          postedAt: j.job_posted_at_datetime_utc?.slice(0, 10) || today(),
          source: 'jsearch',
          country: j.job_country || ''
        })));
      }
      await sleep(500);
    } catch (e) { log('JSearch error:', e.message); }
  }
  return jobs;
}

// ─── Fetch: Adzuna (multi-country) ───────────────────────────────────────────

async function fetchAdzuna() {
  if (!config.sources.adzuna?.enabled || !ADZUNA_ID || !ADZUNA_KEY) return [];
  const jobs = [];
  const countries = config.sources.adzuna.countries || [{ code: 'in', where: 'hyderabad' }];

  for (const ctry of countries) {
    for (const q of (config.sources.adzuna.queries || [])) {
      const url = `https://api.adzuna.com/v1/api/jobs/${ctry.code}/search/1?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=20&what=${encodeURIComponent(q)}&where=${encodeURIComponent(ctry.where || '')}&content-type=application/json`;
      try {
        const res = await httpsGet(url);
        if (res.status === 200 && res.body?.results) {
          jobs.push(...res.body.results.map(j => ({
            title: j.title,
            company: j.company?.display_name || '',
            location: j.location?.display_name || ctry.where || '',
            url: j.redirect_url,
            description: j.description || '',
            postedAt: j.created?.slice(0, 10) || today(),
            source: `adzuna-${ctry.code}`,
            country: ctry.countryName || ctry.code.toUpperCase()
          })));
        }
        await sleep(400);
      } catch (e) { log(`Adzuna ${ctry.code} error:`, e.message); }
    }
  }
  return jobs;
}

// ─── Fetch: MyCareersFuture (Singapore govt, free) ───────────────────────────

async function fetchMyCareersFuture() {
  if (!config.sources.mycareers?.enabled) return [];
  const jobs = [];
  const queries = ['product manager', 'product owner'];
  for (const q of queries) {
    const url = `https://api.mycareersfuture.gov.sg/v2/jobs?search=${encodeURIComponent(q)}&limit=20&sortBy=new_posting_date`;
    try {
      const res = await httpsGet(url, { 'Accept': 'application/json' });
      if (res.status === 200 && res.body?.results) {
        jobs.push(...res.body.results.map(j => ({
          title: j.title || '',
          company: j.postedCompany?.name || '',
          location: 'Singapore',
          url: `https://www.mycareersfuture.gov.sg/job/${j.uuid}`,
          description: j.description || '',
          postedAt: j.metadata?.createdAt?.slice(0, 10) || today(),
          source: 'mycareers-sg',
          country: 'Singapore'
        })));
      }
      await sleep(400);
    } catch (e) { log('MyCareersFuture error:', e.message); }
  }
  return jobs;
}

// ─── Fetch: Canada Job Bank (free govt API) ───────────────────────────────────

async function fetchCanadaJobBank() {
  if (!config.sources.canadajobbank?.enabled) return [];
  const jobs = [];
  const url = `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=product+manager&locationstring=&date=1&action=search`;
  try {
    // Job Bank requires browser-like scraping — skip if not configured
    log('Canada Job Bank: requires dedicated scraping setup, skipping');
  } catch (e) { log('CanadaJobBank error:', e.message); }
  return jobs;
}

// ─── Fetch: Greenhouse ───────────────────────────────────────────────────────

async function fetchGreenhouse() {
  if (!config.sources.greenhouse?.length) return [];
  const jobs = [];
  for (const slug of config.sources.greenhouse) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    try {
      const res = await httpsGet(url);
      if (res.status === 200 && res.body?.jobs) {
        jobs.push(...res.body.jobs.map(j => ({
          title: j.title,
          company: slug,
          location: j.location?.name || '',
          url: j.absolute_url,
          description: j.content || '',
          postedAt: j.updated_at?.slice(0, 10) || today(),
          source: 'greenhouse',
          country: ''
        })));
      }
      await sleep(300);
    } catch (e) { log(`Greenhouse ${slug} error:`, e.message); }
  }
  return jobs;
}

// ─── Fetch: Lever ────────────────────────────────────────────────────────────

async function fetchLever() {
  if (!config.sources.lever?.length) return [];
  const jobs = [];
  for (const slug of config.sources.lever) {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    try {
      const res = await httpsGet(url);
      if (res.status === 200 && Array.isArray(res.body)) {
        jobs.push(...res.body.map(j => ({
          title: j.text,
          company: slug,
          location: j.categories?.location || '',
          url: j.hostedUrl,
          description: (j.descriptionPlain || j.description || '').replace(/<[^>]+>/g, ' '),
          postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : today(),
          source: 'lever',
          country: ''
        })));
      }
      await sleep(300);
    } catch (e) { log(`Lever ${slug} error:`, e.message); }
  }
  return jobs;
}

// ─── Pre-filter ───────────────────────────────────────────────────────────────

const SPONSORSHIP_POSITIVE = [
  'visa sponsor', 'sponsorship', 'work permit', 'relocation', 'skilled worker',
  'global talent', 'tier 2', 'tier-2', 'employment pass', 'blue card',
  'work authorisation', 'work authorization', 'visa support', 'right to work',
  'will sponsor', 'can sponsor', 'open to sponsor'
];

const SPONSORSHIP_NEGATIVE = [
  'no sponsorship', 'not able to sponsor', 'unable to sponsor',
  'must have right to work', 'must be authorised to work',
  'must be authorized to work', 'us citizens only', 'citizens only',
  'no visa', 'sponsorship not available'
];

function preFilter(jobs) {
  const { titleKeywords, titleExclude, locationKeywords } = config.matching;
  const visa = profile.visaProfile || {};
  const targetCountries = (visa.targetCountries || []).map(c => c.toLowerCase());
  // Also keep Hyderabad/India roles (local market)
  const allLocations = [...(locationKeywords || []), ...targetCountries,
    'remote', 'uk', 'united kingdom', 'singapore', 'germany', 'australia',
    'united states', 'usa', 'us '];

  return jobs.filter(j => {
    const title = (j.title || '').toLowerCase();
    const loc   = (j.location || '').toLowerCase();
    const desc  = (j.description || '').toLowerCase();
    const country = (j.country || '').toLowerCase();

    // Title must match at least one keyword
    const titleOk = titleKeywords.some(k => title.includes(k.toLowerCase()));
    if (!titleOk) return false;

    // Title must not match any exclude keyword
    const titleExcluded = titleExclude.some(k => title.includes(k.toLowerCase()));
    if (titleExcluded) return false;

    // Location must match allowed locations or country
    const locationOk = allLocations.some(l => loc.includes(l) || country.includes(l));
    if (!locationOk) return false;

    // Hard drop: explicit no-sponsorship language
    const hasNegative = SPONSORSHIP_NEGATIVE.some(p => desc.includes(p));
    if (hasNegative) return false;

    return true;
  });
}

// ─── Sponsorship signal check ─────────────────────────────────────────────────

function quickSponsorshipCheck(job) {
  const text = (job.description + ' ' + job.title).toLowerCase();
  // If it's a Hyderabad/India local role, sponsorship is N/A — treat as local
  const localMarkers = ['hyderabad', 'india', 'telangana'];
  const isLocal = localMarkers.some(l => (job.location || '').toLowerCase().includes(l));
  if (isLocal) return 'local';

  const hasNegative = SPONSORSHIP_NEGATIVE.some(p => text.includes(p));
  if (hasNegative) return 'no';

  const hasPositive = SPONSORSHIP_POSITIVE.some(p => text.includes(p));
  if (hasPositive) return 'likely'; // LLM will confirm/upgrade to 'confirmed'

  return 'unclear';
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function dedup(jobs, seen) {
  const retention = config.matching.retentionDays || 10;
  const cutoff = new Date(Date.now() - retention * 86400000).toISOString().slice(0, 10);

  // Prune old seen entries
  for (const h of Object.keys(seen.hashes || {})) {
    if (seen.hashes[h] < cutoff) delete seen.hashes[h];
  }

  const fresh = [];
  for (const job of jobs) {
    const h = hash(`${job.title}|${job.company}|${job.location}`);
    job.hash = h;
    if (!seen.hashes[h]) {
      seen.hashes[h] = today();
      job.firstSeen = today();
      fresh.push(job);
    }
  }
  return fresh;
}

// ─── LLM: score job ──────────────────────────────────────────────────────────

const SCORE_SYSTEM = `You are a precision job-matching engine for a senior product professional.
Return ONLY valid JSON, no markdown, no preamble.`;

function buildScorePrompt(job, prof) {
  const vp = prof.visaProfile || {};
  return `Score this job against the candidate profile and assess visa sponsorship signal.

## Candidate
Name: ${prof.profile.name}
Current role: ${prof.profile.currentRole}
Experience: ${prof.profile.yearsExperience} years
Summary: ${prof.profile.summary}
Domains: ${prof.profile.domains.join(', ')}
Skills: ${prof.profile.skills.join(', ')}
Seniority: ${prof.profile.seniority}
Notable achievements:
- Platform availability 99.9% → 99.999%, downtime cut from 8.7hr/yr to under 6 min (Wells Fargo core banking)
- 66.5% fully digital completion, onboarding time halved from 18→9 min (Small Business Deposit App)
- ₹500 crore (~$60M) disbursed in year 1 (COVID-era loan origination platform, Piramal Finance)
- 4 apps shipped independently to Google Play / web, including monetised Android apps with subscriptions, Play Billing, and a live autonomous trading simulator
- J.D. Power mobile app ranking improved #5 → #2 during tenure

Target roles: ${prof.preferences.targetRoles.join(', ')}
Target locations: ${prof.preferences.locations.join(', ')}
Visa nationality: ${vp.nationality || 'Indian'}
Target countries for sponsorship: ${(vp.targetCountries || []).join(', ')}
Relocation: ${vp.willingToRelocate ? 'Yes, full relocation' : 'No'}
Dealbreakers: ${prof.preferences.dealbreakers}

## Job
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Country: ${job.country || 'unknown'}
Posted: ${job.postedAt}
Source: ${job.source}

Description (first 1500 chars):
${(job.description || '').slice(0, 1500)}

## Instructions

Return a single JSON object with these exact fields:
{
  "score": <0-100 integer>,
  "seniorityFit": "good" | "stretch" | "mismatch",
  "verdict": "<one sentence, max 20 words, specific to this role>",
  "pros": ["<specific pro>", "<specific pro>", "<specific pro>"],
  "cons": ["<specific con>", "<specific con>"],
  "sponsorshipSignal": "confirmed" | "likely" | "unclear" | "no" | "local",
  "sponsorshipEvidence": "<exact phrase from JD that led to this signal, or empty string>",
  "visaType": "<e.g. UK Skilled Worker, Singapore Employment Pass, German Blue Card, or empty>",
  "detectedCountry": "<country name this role is based in>"
}

Scoring rubric:
- 85-100: Near-perfect fit. Role matches domain, seniority, genuine PO ownership.
- 70-84: Good fit with minor gaps.
- 60-69: Possible fit but meaningful mismatches.
- Below 60: Weak fit — still return score, will be filtered by minScore.

Sponsorship signal:
- "confirmed": JD explicitly states they sponsor visas / work permits.
- "likely": JD mentions relocation support, "global talent", "right to work assistance", or company is a known large global employer likely to sponsor.
- "unclear": No mention either way for an international role.
- "no": JD explicitly says no sponsorship or requires existing right to work.
- "local": Role is in India (Hyderabad) — sponsorship not applicable.

Seniority: "good" = correct level, "stretch" = slightly above/below, "mismatch" = clearly wrong level.`;
}

async function scoreWithGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('No Gemini key');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await httpsPost(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
  });
  if (res.status !== 200) throw new Error(`Gemini ${res.status}`);
  const text = res.body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function scoreWithGroq(prompt) {
  if (!GROQ_KEY) throw new Error('No Groq key');
  const res = await httpsPost('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SCORE_SYSTEM },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 500
  }, { Authorization: `Bearer ${GROQ_KEY}` });
  if (res.status !== 200) throw new Error(`Groq ${res.status}`);
  const text = res.body?.choices?.[0]?.message?.content || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function scoreJob(job) {
  const prompt = buildScorePrompt(job, profile);
  try {
    return await scoreWithGemini(SCORE_SYSTEM + '\n\n' + prompt);
  } catch (e) {
    log('Gemini failed, trying Groq:', e.message);
    try {
      return await scoreWithGroq(prompt);
    } catch (e2) {
      log('Groq also failed:', e2.message);
      return null;
    }
  }
}

// ─── LLM: insights brief ─────────────────────────────────────────────────────

async function generateInsights(scoredJobs) {
  const vp = profile.visaProfile || {};
  const countries = (vp.targetCountries || []).join(', ');
  const topJobs = scoredJobs.slice(0, 5).map(j =>
    `- ${j.title} at ${j.company} (${j.location}, score: ${j.score}, sponsorship: ${j.sponsorshipSignal})`
  ).join('\n');

  const prompt = `You are a career intelligence analyst for a senior product manager from India actively seeking visa-sponsored roles in ${countries}.

Candidate: ${profile.profile.name}, ${profile.profile.yearsExperience} years, digital banking and fintech PM, also independently shipped 4 Android/web apps.

Today's top matched roles:
${topJobs || 'No roles scored yet.'}

Generate a JSON insights brief with this exact structure (no markdown, no preamble):
{
  "generatedAt": "${today()}",
  "trends": [
    { "label": "<short trend name>", "detail": "<2 sentences, specific and actionable>" },
    { "label": "...", "detail": "..." },
    { "label": "...", "detail": "..." }
  ],
  "news": [
    { "headline": "<punchy headline>", "summary": "<1-2 sentences relevant to this candidate>" },
    { "headline": "...", "summary": "..." },
    { "headline": "...", "summary": "..." }
  ],
  "certifications": [
    { "name": "<cert name>", "provider": "<provider>", "why": "<1 sentence why relevant for visa-sponsored PM roles>" },
    { "name": "...", "provider": "...", "why": "..." },
    { "name": "...", "provider": "...", "why": "..." }
  ],
  "visaIntel": [
    { "country": "<country>", "trend": "<1 sentence on PM hiring + visa climate>", "topSponsors": ["<company>", "<company>", "<company>"] },
    { "country": "...", "trend": "...", "topSponsors": [] }
  ]
}

Rules:
- trends: focus on PM job market in ${countries}, AI product roles, fintech hiring
- news: hiring trends, visa policy changes, notable company expansions into target countries
- certifications: prioritise those that help with visa applications (e.g. AWS, PMP, SAFE) or AI product roles
- visaIntel: one entry per target country, name real companies known to sponsor Indian PMs
- Be specific, not generic. Avoid filler sentences.`;

  try {
    const raw = await scoreWithGemini(prompt);
    return raw;
  } catch (e) {
    log('Insights Gemini failed, trying Groq:', e.message);
    try {
      return await scoreWithGroq(prompt);
    } catch (e2) {
      log('Insights generation failed:', e2.message);
      return null;
    }
  }
}

// ─── Load existing board ──────────────────────────────────────────────────────

function loadExistingJobs() {
  if (!fs.existsSync(RESULTS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    // Drop sample rows and expired rows
    const retention = config.matching.retentionDays || 10;
    const cutoff = new Date(Date.now() - retention * 86400000).toISOString().slice(0, 10);
    return (data.jobs || []).filter(j =>
      j.firstSeen && j.firstSeen !== '2000-01-01' && j.firstSeen >= cutoff
    );
  } catch { return []; }
}

// ─── Write outputs ────────────────────────────────────────────────────────────

function writeResults(allJobs, meta) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ meta, jobs: allJobs }, null, 2));
  log(`Wrote ${allJobs.length} jobs to ${RESULTS_PATH}`);
}

function writeInsights(insights) {
  if (!insights) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INSIGHTS_PATH, JSON.stringify(insights, null, 2));
  log(`Wrote insights to ${INSIGHTS_PATH}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Career Orbit agent starting —', today());

  if (!shouldRun()) process.exit(0);

  const seen = loadSeen();
  seen.lastRun = today();

  // 1. Fetch from all sources
  log('Fetching jobs...');
  const [jsearch, adzuna, mycareers] = await Promise.all([
    fetchJSearch(),
    fetchAdzuna(),
    fetchMyCareersFuture()
  ]);
  const greenhouse = await fetchGreenhouse();
  const lever = await fetchLever();

  const raw = [...jsearch, ...adzuna, ...mycareers, ...greenhouse, ...lever];
  log(`Fetched ${raw.length} raw jobs`);

  // 2. Pre-filter
  const filtered = preFilter(raw);
  log(`${filtered.length} jobs after pre-filter`);

  // 3. Dedup — only score jobs we haven't seen
  const fresh = dedup(filtered, seen);
  log(`${fresh.length} fresh jobs to score`);

  // 4. Quick sponsorship screen — drop confirmed "no" before LLM
  const toScore = fresh.filter(j => {
    const sig = quickSponsorshipCheck(j);
    if (sig === 'no') return false;
    j._quickSignal = sig;
    return true;
  });
  log(`${toScore.length} jobs to score after quick sponsorship screen`);

  // 5. LLM scoring
  const minScore = config.matching.minScore || 60;
  const minSponsorship = config.matching.minSponsorshipSignal || ['confirmed', 'likely', 'local'];
  const newlyScored = [];

  for (let i = 0; i < toScore.length; i++) {
    const job = toScore[i];
    log(`Scoring ${i + 1}/${toScore.length}: ${job.title} @ ${job.company}`);
    await sleep(300);

    const result = await scoreJob(job);
    if (!result) continue;

    // Apply score threshold
    if (result.score < minScore) {
      log(`  → score ${result.score} < ${minScore}, skipping`);
      continue;
    }

    // Apply sponsorship threshold
    const sig = result.sponsorshipSignal || 'unclear';
    if (!minSponsorship.includes(sig)) {
      log(`  → sponsorship "${sig}" not in allowed set, skipping`);
      continue;
    }

    newlyScored.push({
      hash: job.hash,
      company: job.company,
      title: job.title,
      location: job.location,
      country: result.detectedCountry || job.country || '',
      url: job.url,
      source: job.source,
      score: result.score,
      seniorityFit: result.seniorityFit,
      verdict: result.verdict,
      pros: result.pros || [],
      cons: result.cons || [],
      sponsorshipSignal: sig,
      sponsorshipEvidence: result.sponsorshipEvidence || '',
      visaType: result.visaType || '',
      postedAt: job.postedAt,
      firstSeen: job.firstSeen
    });
    log(`  → score ${result.score}, sponsorship: ${sig} ✓`);
  }

  // 6. Merge with existing board
  const existing = loadExistingJobs();
  // Remove any that were re-fetched (update in place)
  const existingFiltered = existing.filter(e => !newlyScored.find(n => n.hash === e.hash));
  const allJobs = [...newlyScored, ...existingFiltered];

  // Sort: confirmed first, then likely, then local, then by score
  const sigOrder = { confirmed: 0, likely: 1, local: 2, unclear: 3, no: 4 };
  allJobs.sort((a, b) => {
    const sA = sigOrder[a.sponsorshipSignal] ?? 3;
    const sB = sigOrder[b.sponsorshipSignal] ?? 3;
    if (sA !== sB) return sA - sB;
    return b.score - a.score;
  });

  // 7. Write results
  const meta = {
    lastRun: today(),
    generatedAt: new Date().toISOString(),
    scanned: raw.length,
    newlyScored: newlyScored.length,
    newMatches: newlyScored.length,
    onBoard: allJobs.length
  };
  writeResults(allJobs, meta);

  // 8. Generate insights (once per day)
  const existingInsights = fs.existsSync(INSIGHTS_PATH)
    ? JSON.parse(fs.readFileSync(INSIGHTS_PATH, 'utf8'))
    : null;
  if (!existingInsights || existingInsights.generatedAt !== today()) {
    log('Generating insights brief...');
    const insights = await generateInsights(newlyScored.length ? newlyScored : allJobs);
    writeInsights(insights);
  } else {
    log('Insights already fresh for today — skipping');
  }

  // 9. Save seen
  saveSeen(seen);

  log(`Done. ${newlyScored.length} new matches. ${allJobs.length} total on board.`);
}

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
