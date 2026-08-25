-- Starter queries for data/jobs.db — copy any block into the `jobs>` prompt.
-- Open the database with:  npm run db      (read-only, safe to explore)
-- Leave it with:           .quit

-- ─── Orientation ──────────────────────────────────────────────────────────

.tables                          -- list every table
.schema jobs                     -- show the columns of the jobs table

-- Counts change with every daily sweep; these are from 2026-08-24.
SELECT count(*) FROM jobs;                     -- 343,173 rows, closed ones included
SELECT count(*) FROM jobs WHERE is_open = 1;   -- 337,888 open jobs
SELECT count(*) FROM companies;                -- 15,265

-- ─── Look at actual jobs ──────────────────────────────────────────────────

-- 10 jobs, the columns that matter
SELECT title, company_name, d_metros, d_workplace, d_seniority, d_salary_min
FROM jobs LIMIT 10;

-- Everything about one single job, printed vertically (easiest way to see
-- the raw columns and the derived d_* columns side by side)
.mode line
SELECT * FROM jobs LIMIT 1;
.mode box

-- ─── Counting things ──────────────────────────────────────────────────────

-- How many jobs per workplace type
SELECT d_workplace, count(*) AS jobs FROM jobs GROUP BY d_workplace ORDER BY jobs DESC;

-- The 20 biggest metros
SELECT metro, count(*) AS jobs FROM job_metros GROUP BY metro ORDER BY jobs DESC LIMIT 20;

-- Companies posting the most roles
SELECT company_name, count(*) AS jobs FROM jobs GROUP BY company_name ORDER BY jobs DESC LIMIT 20;

-- ─── Your actual search ───────────────────────────────────────────────────
--
-- You probably want `npm run find` or `npm run serve` instead of this block:
-- both apply the three-valued unknown rules, word-boundary keyword matching and
-- ranking that the SQL below cannot express. Kept because hand-querying is still
-- the fastest way to check whether the filter engine is telling you the truth.

-- NYC + in-person + entry-ish + one of your role keywords
SELECT j.title, j.company_name, j.d_seniority, j.d_min_years, j.url
FROM jobs j
JOIN job_metros m ON m.job_id = j.id
WHERE m.metro = 'nyc'
  AND j.is_open = 1
  AND j.d_workplace IN ('onsite','hybrid')
  AND j.d_seniority IN ('entry','junior','intern')
  AND (j.title LIKE '%Implementation%' OR j.title LIKE '%Solutions%'
       OR j.title LIKE '%Analyst%' OR j.title LIKE '%Associate%'
       OR j.title LIKE '%Specialist%' OR j.title LIKE '%Operations%')
ORDER BY j.posted_at DESC
LIMIT 40;

-- ─── Keyword search across full descriptions ──────────────────────────────

SELECT j.title, j.company_name, j.d_metros
FROM jobs_fts f
JOIN jobs_fts_map map ON map.rowid = f.rowid
JOIN jobs j ON j.id = map.job_id
WHERE f.jobs_fts MATCH 'implementation AND consulting'
LIMIT 20;

-- ─── Saving results to a file you can open in Excel ───────────────────────

.mode csv
.output nyc-jobs.csv
SELECT title, company_name, d_seniority, url FROM jobs j
  JOIN job_metros m ON m.job_id = j.id WHERE m.metro = 'nyc';
.output stdout
.mode box
