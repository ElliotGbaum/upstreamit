# Filter research — what sixty job boards have that we don't

Seven parallel research passes, 22 August 2026, measured against what the left rail actually
does today. Findings come from live API probes, shipped JavaScript bundles, official developer
documentation and archived markup; anything an agent could not verify is marked `[UNVERIFIED]`
or omitted. Corpus figures were measured directly against `data/jobs.db` on the same date.

**The short version: we are already ahead of every one of them on the hard problem, and behind
most of them on the easy ones.**

| | |
| --- | --- |
| Open jobs | 61,213 |
| Companies | 3,764 |
| Sources swept | 1 of 20 (Ashby only) |
| Rail panels | 13 |
| Corpus that is duplicate postings | 16.6% |

---

## 1. What the rail does today

Thirteen panels plus a "show" selector in the header:

Search (FTS5) · Title keywords (any/all) · Description keywords (any/all) · Title exclusions ·
Description exclusions · Company exclusions · Location (metro + country + "remote counts") ·
Workplace · Experience (years + seniority band + interns) · Salary (min/max + bands) ·
Posted (age bands) · Type & family · Skills

This is a genuinely strong set — broader than Talent.com, Monster, CareerBuilder, ZipRecruiter
or Dice, and one of only three boards in the entire survey with negative keyword filters
(the others being Otta and Rise).

### The thing we already win on

Every criterion that can come back unknown carries a policy — `include`, `exclude` or
`separate` — and `UNKNOWNABLE` publishes the measured silent share next to each one:
96.8% on sponsorship, 75.6% on degree, 62.8% on salary, 28.4% on skills, 24.9% on seniority,
15.9% on location.

**Across sixty-plus boards, not one has an equivalent.** The closest are single booleans on a
single criterion:

- Adzuna `salary_include_unknown` / `si` (a hidden field, `id="f_salary_inc"`, serialising to
  `include_undef:"1"`)
- Glassdoor `includeNoSalaryJobs=true`
- Himalayas "Include jobs without salary"
- Stack Overflow Jobs (dead) "Include jobs that don't have a salary listed"
- Wellfound — the only board with two: "no salary listed" and "no experience listed"
- Remote.co — three: salary info / non-USD / pay cycle

We have eleven criteria, three states each, with the cost of each choice printed on screen.
**It is not wired to the page.**

---

## 2. Built, never exposed

Five filters exist in `profile.mjs`, are derived in `signals.mjs`, are honoured by the query
engine, and have **no control anywhere in the page**. These cost markup, not engineering.

| Filter | Profile field | Column | Filled |
| --- | --- | --- | --- |
| Degree requirement | `degree[]` | `d_degree` | 24.4% |
| Sponsors visas | `requires_visa_sponsorship` | `d_visa` | 3.2% |
| Drop "we don't sponsor" | `exclude_visa_refusal` | `d_visa` | 3.2% |
| No security clearance | `exclude_clearance` | `d_clearance` | 1.5% yes |
| Company allow-list | `companies[]` | `company_slug` | 100% |
| Unknown policies | `unknowns{}` | — | 11 criteria |

### One caveat on degree

CareerBuilder's retired API had the right semantics and nobody has copied them:
`EducationCode` matched **"this level or lower"** unless you passed `SpecificEducation=true`.
A degree filter means "I have at most a bachelor's", not "the posting must say bachelor's".
Our `degree[]` is an exact-set match, which is the wrong shape.

**No board in the survey implements "this level or lower".** Every education facet verified —
Idealist, Handshake, Indeed, jobs.ac.uk, USAJOBS' applicant-side `DegreeTypeCode` — is a flat
multi-select enum. This is open design space, not a solved problem.

---

## 3. Table stakes we're missing

### Sort — MISSING

There is no sort control on the page at all. We have seven tunable weights in
`DEFAULT_WEIGHTS` and expose none of them.

- **Who has it:** RemoteOK ships seven options including *most viewed*, *most applied* and
  *most benefits*. Adzuna has four (relevance, recent, highest salary, lowest salary).
  Levels.fyi sorts by pay. AcademicJobsOnline sorts by postdate, enddate, **deadline**,
  startdate, distance and status.
- **Who doesn't:** ZipRecruiter, Monster, CareerBuilder, Talent.com, Remotive, We Work
  Remotely, Remote.co, JustRemote, Working Nomads and Jobspresso have none either.
  Dice's sort is client-side only. We Work Remotely's "sort" dropdown is *mislabelled* —
  every option is a date filter.

### Distance / radius from a point — MISSING

Our location filter is metro membership. There is no "within 25 miles of this address", and
`metros` already carries `lat`/`lon` columns that are unused.

- Indeed: exact / 5 / 10 / 15 / 25 / 50 / 100 mi, default 25
- Dice: 10 / 30 / 50 / 75 only, default 30 — out-of-range values **silently snap** (5→10, 100→75)
- ZipRecruiter: a slider, `aria-valuemin="1"`, `aria-valuemax="5000"`
- Idealist: radius **in metres** (8000 = 5mi)
- The Ladders: radius **in km**
- Talent.com: value is **always in km even when the UI shows miles**
- Adzuna: documented in km (default 5km) while the US UI presents miles

### Industry and job function as separate axes — PARTIAL

We have one `d_job_family` enum of 26 values doing both jobs. Industry (what the company does)
and function (what you'd do there) are independent.

- Glassdoor: 25 sectors × 23 functions as separate facets (`industryType`, `sgocId`)
- SmartRecruiters: the only ATS with a native industry + function + seniority triple
- Otta: 175 industry tags, 10 functions → 67 sub-functions
- Built In: 103 industries
- Welcome to the Jungle: 20 sectors with sub-sectors
- Idealist: 44 functions × 56 cause areas

### Company size — MISSING

We can compute a decent proxy today. Open headcount per company, measured:

| Openings | Companies | Jobs |
| --- | --- | --- |
| 1 | 318 | 318 |
| 2–5 | 1,168 | 3,937 |
| 6–20 | 1,607 | 17,506 |
| 21–100 | 589 | 23,073 |
| 101–500 | 79 | 13,387 |
| 500+ | 3 | 2,992 |

Who has it: Otta, Wellfound, Built In, Levels.fyi, Glassdoor, Blind, Welcome to the Jungle,
iHire. **Levels.fyi labels the buckets by stage** — Seed 1–50, Early 51–200, Mid-size 201–1,000,
Large 1,001–10,000, Enterprise 10,001+ — which reads better than raw headcount.

### Benefits and perks — MISSING

No facet at all. Descriptions are 100% present and average ~5 KB — this is the same
regex-over-prose pass that already produces skills and clearance.

- **Built In: 90 perks**, including 4-day work week, generous parental leave, pair programming,
  pay transparency, company equity, unlimited PTO, sabbatical leave, fertility benefits,
  transgender health care, abortion travel benefits, Employee Resource Groups, post-parental-leave
  return-to-work programme, home-office stipend, OKR operational model, summer hours, quarterly
  engagement surveys, pension, birthday day off
- **RemoteOK: 24**, including `async`, `distributed_team`, `4_day_workweek`, `no_monitoring`,
  `no_whiteboard`, `no_politics`, `hire_old`, `pseudonymous`, `pay_in_crypto`, `coworking_budget`,
  `learning_budget`, `mental_wellness_budget`
- **Escape the City: 26**, including 4 day week, **9 day fortnight**, parental leave 3 months+
  full pay, task-based interview, home internet subsidy, paid sabbatical, pet friendly
- **Vivian: 30**, including **guaranteed hours** (87,783 jobs), **cancelation protection**
  (21,066), benefits start day 1, licence and certification reimbursement (68,301),
  school loan reimbursement
- **Health eCareers: ~37**, including malpractice insurance, loan assistance, licence
  reimbursement, continuing education credits, **partner opportunity** (dual-career)
- **iHire: 19**, and uniquely **AND-combined** rather than OR
- Levels.fyi: 10. FlexJobs: 6.

Otta stores benefits as free text, which is exactly why it has no filter.

### Easy apply / application type — MISSING

We store `apply_url` on 100% of jobs and never filter on what kind of application it leads to.

Who has it: LinkedIn (`f_AL`, one of only four facets still working), Indeed, Glassdoor
(`applicationType=1`), ZipRecruiter (`refine_by_apply_type=has_zipapply`), Dice, Talent.com
(`apply_type=quickApply`), Rise.

---

## 4. Worth stealing

### Graded remote, not three buckets — HIGH VALUE

**Escape the City grades work arrangement as a percentage:**
In person (1,017) · Hybrid-20% (41) · Hybrid-40% (253) · Hybrid-60% (454) · Remote-80% (4) ·
Remote-98% (169) · Remote-100% (233).

FlexJobs' legacy `tele_level` ladder went further — the most granular remote taxonomy anyone has
shipped: All Telecommuting · Mostly · Partial · Some · Option for · Any Level of · No
Telecommuting · Remote-During-Pandemic.

Our `WORKPLACE_TYPES` is `onsite | hybrid | remote`, and hybrid is ~30% of the market. That one
word hides the difference between one day a week in the office and four — frequently the fact
that decides whether someone can take the job.

**Nobody filters on days-per-week in office.** Otta is the only board that even stores it
(`minDaysInOffice`/`maxDaysInOffice`, rendered as "2-3 days") and it isn't filterable there
either.

Other granular remote models worth noting:
- USAJOBS: **three-state** — Remote jobs / Exclude remote jobs / **Offers telework**. Omitting
  `RemoteIndicator` means remote jobs are **included by default**; only `False` excludes.
- CalCareers: In Office / Hybrid / Telework, **with inline definitions**
- NEOGOV: Remote Only / Remote Optional / Flexible-Hybrid
- Wellfound: 3-way radio — No remote / Include remote / **Only remote**, plus
  `remoteCompanyLocations` ("show remote jobs of companies based in…") and "Distributed teams only"
- Recruitee: **three independent booleans** — `remote`, `hybrid`, `on_site`
- iHire: same, three independent checkboxes `rem` / `hyb` / `inp`, OR within group

### Recruiter vs direct employer — HIGH VALUE

Dice's `employerType` facet: **Direct Hire** (63,442) · **Recruiter** (14,471) · Other (5,963).
A fifth of its postings are agency-sourced and it is the only mainstream board that lets you
exclude them.

Also in this family:
- PracticeLink **Recruitment Type**: Employer Direct (27,915) / Search Firm (11,809) / Both (39,724)
- Inside Higher Ed **Employer Type**: Employer / Search Firm
- Health eCareers employer facet includes **Staffing Agency**

Monster and CareerBuilder have never had a "posted by" facet — not in the filter component,
string table, analytics facet list, or the 2016 legacy rail. Stack Overflow Jobs' famous
anti-recruiter stance was a *posting policy*, not a filter.

### Tech you like *and* tech you dislike — HALF-BUILT

Stack Overflow Jobs, dead since March 2022, still has the best tech-stack filter ever shipped:
`tl` (tech you like) paired with `td` (tech you dislike). Plus `cl`/`cd` — companies to include
and companies to exclude — and `ms`/`mxs`, min **and** max experience as a real range.

Its full param set is worth reading as prior art: `q` `l` `d`(distance) `u`(units) `r`(remote)
`tl` `td` `s`(min salary) **`c`(currency, 11 options)** `e`(offers equity) `v`(visa sponsor)
**`t`(offers relocation)** `b`(perks) `ms`/`mxs` `dr`(role, 14) `j`(job type) `cl`/`cd`
`i`(industry, 71) `sort`.

Perks vocabulary included **`FirstApplicants`** ("be one of the first applicants") and
**`HighResponse`** ("high response rate").

Otta is the only live board with the same instinct — 482 technologies weighted
`POSITIVE`/`VERY_POSITIVE`/`NEGATIVE`, plus hidden industries (max 30, warns past 10) and hidden
companies. Rise has a "Keywords to Exclude" field. Remote Rocketship has `excludeIndustries`.
FlexJobs has `excludeWords`.

**Correction to a common assumption:** Stack Overflow Jobs had **no** company-size facet and
**no** "no recruiters" facet.

### Structured requirements, not prose — HIGH VALUE

**USAJOBS has the richest structured filter set in existence** and most of it is transferable.

- **Security clearance** (`sc`), 8 graded values: Not Required · Confidential · Secret ·
  Top secret · Sensitive Compartmented Information · Q Access Authorization · L Access
  Authorization · Other. (Q-Nonsensitive and Public Trust exist in the codelist but are disabled.)
  We have a single `exclude_clearance` boolean, and `CLEARANCE_RE` already distinguishes
  *top secret* from *public trust* then throws the distinction away.
- **Travel** (`t`), six buckets: Not required · Occasional travel · 25% or less · 50% or less ·
  75% or less · 76% or greater
- **Relocation assistance** (`ri`), yes/no — nobody else has this today
- **Work schedule** (`ws`): Full-time · Part-time · **Shift work** (positions requiring 24-hour
  coverage) · Intermittent · **Job sharing** (two employees share one full-time job, pro-rata pay
  and benefits) · Multiple schedules
- **Appointment type** (`wt`), 12 values: Detail · Intermittent · Internships · Multiple ·
  Permanent · Recent graduates · Seasonal · Summer · **Supervisor** · Temporary (NTE 1 year) ·
  Temporary promotion · Term (1–4 years)
- **Hiring path** (`hp`), 17 values in six semantic clusters: public · fed-competitive ·
  fed-excepted · fed-internal-search · fed-transition (CTAP/ICTAP/RPL) · land · vet · mspouse ·
  nguard · student · graduates · ses · disability (Schedule A) · overseas · native · peace ·
  special-authorities
- **Occupational series** (`j`): 756 active of 822, grouped into **60 job families**
- **Agency**: 1,067 subelements under ~130 parent departments

API params with no UI facet: `PositionSensitivity`, `CyberWorkGrouping`, `CyberWorkRole`
(~50 NICE-framework roles), `SocTitle`, `JobCategoryFamily`, `SupervisoryStatus`,
`ExcludeOrganizations`, `MissionCriticalTags`.

**USAJOBS codelists that are posting data but not filters — the best steal list found:**

- `KeyStandardRequirements`: DRUGTEST (designated or random drug testing) · FITNESS
  (pre-employment fitness exam) · PHYSICAL · SCREENING · PROBATION (1-year probationary period) ·
  SSR (Selective Service registration) · USCITIZEN · OGE278/SF278 (public financial disclosure)
- `SpecialHirings`: DISVET30 (30%+ disabled veteran) · DISVETTR · MILSPOUSE · MILSPOUSEOS ·
  SCHEDA · VRA
- `AnnouncementClosingType`: Closing Date · **Open Continuous** · **Applicant Cut-Off** · Closing Time
- `RemunerationRateInterval`: Per Year · Per Hour · Per Month · Bi-weekly · Per Day · Piece Work ·
  Fee Basis · **Student Stipend Paid** · **School Year** · **Without Compensation**
- `DegreeTypeCode` (9): Some high school (no diploma) · High school diploma or equivalent ·
  Technical or occupational certificate · Associate's · Some college (no degree) · Bachelor's ·
  Master's · Doctorate · Professional (MD, JD, DDS)
- `AcademicLevel`: Student (High School / College / Graduate) · Entry Level · Mid-Career
  Professional · Manager · Executive · Senior Executive · Subject Matter Expert
- `payplans` (391 values) includes **WT "Apprentices And Shop Trainees, Federal Wage System"**,
  BB/BL/BP/BS "Negotiated Pay Employees", XI/XJ/XK "Prevailing Rate System"

**Aya Healthcare** goes one better with two candidate-side filters:
- `specialty[][expertiseDuration]` — a **per-specialty** years-of-experience selector, 0 through 25
- `licenseStatesSelect` — which state licences **you already hold** (51 values)

**Trucking boards have the most structured filters in any industry** (AllTruckJobs / CDLjobs,
shared platform, both fields required):
- `driver_type`: owner-operator · company driver · **student**
- `freight_type`: Dry Van · Refrigerated · Tanker · Dry Bulk · Flatbed · Car Hauler ·
  **Oversize Load** · Intermodal · Box · **Drop and Hook** · **Hopper Bottom** · **Oil Field** ·
  **Yard Spotter**
- `route_type`: Dedicated · Local · LTL · OTR · Regional
- Team Driving: Solo / Team / Both
- **SAP Friendly** — open to drivers in the DOT Substance Abuse Professional return-to-duty
  process; a genuine second-chance-hiring facet
- "Only show jobs I qualify for" (login-gated)
- TruckersReport adds endorsements: **TWIC · HazMat**

### Shift and schedule — MISSING

**Indeed's shift taxonomy is the deepest facet found anywhere** — ~50 values with published SUIDs:

- *Weekly schedule:* 4x10 · 4x12 · 5x8 · 3x12 · **9x80** · Shift system · Weekend availability ·
  Rotating weekends · Every other weekend · Every weekend · Weekends only · Weekdays ·
  Monday to Friday · **No weekends** · Weekends & holidays off · **Choose your own hours** ·
  Flextime · 35 hour work week · **4 day week** · Fixed shift · Compressed hours ·
  Annualised hours · Staggered hours
- *Shift length:* 4 / 8 / 10 / 12 hour shift · Intensive shift
- *Shift time:* Morning · Day · Afternoon · **After school** · Evening · Night · Overnight ·
  **No nights** · **Evenings as needed** · **Nights as needed** · Rotating · Split · Middle ·
  Late · US shift · UK shift
- *Supplemental:* **On call** · **No on call** · Overtime · **No overtime** ·
  Holiday work possible · Extended hours
- *Trucking home time:* **Home daily · Home weekly · Home bi-weekly · Home weekends ·
  Home every 3 weeks**

Health eCareers ships 19 shift values including **self-determined schedule**, no nights, no
weekends, call-in/on-call, PRN, and 4/8/10/12-hour shifts.

Vivian computes a `3x12 / 4x10 / 5x8` breakdown client-side from hours per week; underlying
shift-length table is 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16 hours. Its shift facet is
Days (133,468) · Nights (106,040) · Rotating · Evenings · Flexible · **On call (43)**.

FlexJobs treats schedule as an axis separate from job type: Full-Time · Part-Time ·
**Flexible Schedule** · **Alternative Schedule** · Long-Term · Short-Term · Seasonal · Occasional.

Our corpus is 93% FullTime, so this matters less today — but 1,901 jobs are priced hourly and
that is where scheduling lives.

**Other Indeed Job Sync categories worth mining:**
- *Application qualifications:* 18 or older · No age limitations · **Clean driving record** ·
  **License or certification required** · **Personal car** · **Personal bicycle** ·
  **Pre-employment physical examination** · **Disability certification** · work authorisation
- *Licences* (212 entries) and *Certifications* (119)
- *Dress code* (14): Suit required · Sneakers OK · Uniform · Jeans OK · Piercings OK ·
  No hair style restriction
- *Wage* (56): **Daily pay · Same day pay · Paid weekly · Night shift pay/bonus · On-call bonus ·
  Safety bonus · Clean driving record bonus · Certification bonus · Commission only**
- *"Encouraged to apply"* (41): No experience · Little experience · **Back to work** ·
  **Single parents** · High school dropouts · Disability friendly ·
  **40s/50s/60s/70s can also apply** · New graduates welcome · Different industry experience
- *Contract type:* Seasonal · Temporary · Direct hire · **Short within 1 month / 3 months** ·
  Long contract term · **Disability employment** · Part-time fixed-term

### Contract length and start date — MISSING

Vivian filters on `contractLengthWeeks` across **52 discrete values** — 13 weeks alone covers
250,205 of its 294,029 jobs, then 12 (11,527), 26 (5,424), 16 (4,495), 14, 8, 17, 20, 18, 10,
15, 11, 9, 6 … full range 1–52.

Its start-date facet makes **`ASAP` a first-class value** (147,431 jobs) carried *alongside* a
calendar month bucket. Aya asks the same question from the candidate's side:
*"I'm ready to go!"* · Within the next 2 months · Within the next 6 months · *"I'm just browsing."*

**Nobody outside healthcare staffing has either.** Application deadline is worse still —
**no board filters on it.** Handshake and AcademicJobsOnline expose it only as a *sort*.
NEOGOV, NYC Jobs and USAJOBS all publish closing dates as display-only fields;
`"Continuous"` / blank ("post until filled") are first-class values on each.

### Employer-stated vs estimated pay — WE'RE CLOSE

Glassdoor badges every salary **"Employer Est."** or **"Glassdoor Est."** on the card and offers
**no filter** to restrict to employer-provided pay. Indeed, ZipRecruiter, SimplyHired, Adzuna,
Talent.com, Monster and The Ladders all impute estimates and none let you exclude them.

We already record provenance in `d_salary_src` (`as-stated` vs `reinterpreted:X->Y`). This is a
filter we could ship this week that no board in the survey has.

Related and also unserved: **salary transparency as a filter**. Idealist's `hasSalary` (Yes/No)
is the cleanest implementation found. Rise has "Only show jobs with salary info". Chronicle of
Higher Education makes the blank state selectable through four non-numeric salary buckets —
Commensurate with Experience · Competitive · **Not specified** · Provided in Job Description —
which together cover 23,402 of its 24,330 jobs.

### Orthogonal contract axes — MODELING FIX

Adzuna keeps `contract_type` (permanent/contract) and `contract_time` (full-time/part-time) as
two **independent** fields. Our `EMPLOYMENT_TYPES` flattens both into one enum and therefore
cannot express "part-time contract".

Most granular vocabularies found:
- **Remotive: 11** — full-time, part-time, contract, freelance, temporary, internship,
  **apprenticeship**, **casual**, **per-diem**, volunteer, other
- Health eCareers: Full-Time · Part-Time · **Locum** · **Per Diem** · Contract · **Fellowship** ·
  **Residency** · Internship · Remote · **BE Or BC** (board-eligible / board-certified)
- Vivian: Travel (292,866) · Local Contract · Permanent · Per Diem/PRN · Locum Tenens
- CalCareers work type: Permanent · Limited Term · Retired · Non-Tenured ·
  **Non-Traditional Apprenticeship**; schedule adds **Annuitant**
- Chronicle employment level (where academic tenure lives): Entry-Level · Assistant Professor ·
  Mid-Level · Senior-Level · **Adjunct** · **Fellowship** · **Non-Tenured Track** · **Post-Doc** ·
  **Tenured/Tenure Track**; employment type adds **Interim**
- Wellfound adds **Cofounder**; Escape the City makes **Volunteer** and **Co-Founder**
  first-class listing types; Work in Startups has co-founders as a category
- Lever's `commitment` is **free text**, not an enum — live values include
  "Regular Full Time (Salary)", "Contract - Remote", "Hourly", "Apprenticeship", "Scholarship"
- NEOGOV's `jobType` is **agency-defined free text**, 65 distinct strings, which is where tenure
  concepts hide: "Classified Civil Service, Regular, Full-Time", "Exempt Limited Duration
  Employee (ELDE)", "Long Term Nonperm", "At-Will Full-Time", "Full-Time Grant Funded"

### Company attributes — MISSING

Funding stage, valuation, headcount growth, B-Corp status, YC batch, investor backing,
public vs private.

- **Wellfound badges:** COMPANY_STAGE (Early / Growth / Scale / Public) · TOP_INVESTORS ·
  **GROWING_FAST** ("strong hiring growth in the past month") · **QUICK_RESPONDER /
  TOP_RESPONDER** · ACTIVELY_HIRING · HIGHLY_RATED ("4.1 out of 5 on Glassdoor") ·
  **STRONG_LEADERSHIP** ("4.4/5 for faith in leadership") · WORK_LIFE_BALANCE · VALUATION_* ·
  YC_BADGE · B2B / B2C
- **Levels.fyi** is the only board with a **valuation** filter: <$1B · $1B–$10B · $10.1B–$50B ·
  $50.1B–$100B · $100B+. Also Company Type: Private · Public · Nonprofit · Education
- **TrueUp** filters by **Public tech** (140K+), **Unicorn** (63K+), **a16z portfolio** (15K+)
- **YC Work at a Startup** has `companyBatch` (S16, S20, S24, P25, P26) and
  `companyLastActiveAt` ("about 14 hours ago") — founder/recruiter activity recency
- **Rise** (joinrise.co) has Funding stage, Company Rating and Company Culture facets
- **iHire's "Other" tags:** Government · Military · S&P_500_Firms · Fortune_500_Firms ·
  Will_help_relocate · **Security_Clearance_required** · Consultant · Non-Profit ·
  Will_pay_for_education · **License/Certification_Required**

**Otta stores and filters on none of it:** `totalFunding`, `fundingRounds` (SEED through
SERIES H, LATE VC with dates), `investors[]` each with a `topInvestor` boolean,
`yearEmployeeGrowthPercentage`, `bcorp`, `glassdoorRating`, `trustpilotRating`,
`percentageFemale`, `founders[]` with gender, `ebStatistics`, `applicationProcessBullets`
(the interview process), `oteSalaryRange`. Its GraphQL `personalisedCompanies` query accepts
`investorPreferences` against a `topInvestors` list of **31,343 investors** — dormant, not
exposed in the UI.

### Recruiter responsiveness — UNIQUE TO WELLFOUND

*"Responds within a day / a week / two weeks / three weeks. Based on past data, X usually
responds to incoming applications within…"* YC exposes a weaker version as `companyLastActiveAt`.

Our `job_events` table and `sweeps` history could approximate the inverse — how fast a company's
postings close — once there is more than one day of history. Today `job_events` holds a single
day (2026-08-15, 61,213 `appeared` rows).

### Accolades and eligibility flags — MISSING

- **FlexJobs: 73 employer accolades** (`accolade[]`) — FlexJobs Top 100 Remote · Fortune 500 ·
  S&P 500 · Forbes 2000 · Barron's 400 · Glassdoor Employees Choice · LinkedIn InDemand
  Employers · **DoD Military Spouse Employment Partner (MSEP)** · Canada's Top 100 Employers ·
  Inc 500 · **Human Rights Campaign Best Places to Work** · **50 Best Companies for Latinas**.
  Grouped as: Diversity-Friendly · Environmental/Green · Family-Friendly · Fast Growing ·
  Flex-Friendly Cultures · Great Places to Work · Healthy Lifestyle Cultures · Military-Friendly ·
  Progressive · Public Companies · Remote-Friendly Cultures · Trusted Reputation Awards ·
  Women-Friendly
- **CareerBuilder** had a `cb-veterans` "Supports Veterans" toggle
- **Indeed "Encouraged to apply":** Fair chance · Military encouraged · No degree ·
  No experience necessary
- **Built In is the only board with DEI as a facet** — 9 options: dedicated D&I staff ·
  diversity manifesto · documented equal pay policy · highly diverse management team ·
  **mean gender pay gap is below 10%** · mandated unconscious bias training ·
  diversity-based ERGs · hiring practices promote diversity · diversity recruitment programme
- **Escape the City:** Top 1% Employer · Visa Sponsor · **B-Corp** toggles, plus a 30-item
  **cause taxonomy** (Climate action 227 · Inclusive finance 216 · Sustainable business 175 ·
  Reducing inequalities 150 · Mental health 70 · **Ethical AI 31** · Gender equality ·
  Peace + justice), an **Escape Factor** facet (Socially impactful · Innovative product ·
  People-first culture · Small & unique · **Exotic location** · **Escape to the country**),
  and featured tags including **Async hours** (455), **Open to career changers**,
  **Anonymous hiring**, **No CV cover letter**, **>5% / >8% / 10%+ pension bands**
- **Idealist: 56 cause areas** — the best non-profit taxonomy found

---

## 5. The open lane — nobody filters on these

### Pay relative to market, not an absolute number — THE BIG ONE

Every board filters salary as a dollar threshold, which is nearly meaningless across roles and
cities. $120k is generous for a Denver support lead and low for a Bay Area staff engineer.

- **O*NET 30.3** publishes `Job Titles.xlsx` — **57,543 lay job titles mapped to SOC codes**,
  CC BY 4.0, free commercial use with attribution. Plus `Sample of Reported Titles.xlsx` (7,953).
- **BLS OEWS (May 2025)** publishes mean, median and **10th / 25th / 75th / 90th percentile
  wages by SOC code × geography** — national, state, MSA and nonmetro. Public domain.

Normalise title → SOC, join OEWS, and we can offer **"pays above the 75th percentile for this
role in this metro."**

**Adzuna already badges cards "ABOVE AVERAGE SALARY"**, so the idea is commercially validated —
but no board exposes it as a filter. Two boards independently confirm the approach works:
**CalCareers keys its job categories on BLS SOC major groups** (`11-0000` Management through
`55-0000` Military Specific) and expands unquoted keyword searches through **O*NET
occupational-group mappings**; **Handshake's 385 role groups → 8,600+ roles taxonomy is
SOC-based**.

It also unlocks a second free axis: SOC major groups are a real job-family taxonomy, replacing
our hand-rolled 26-value enum.

Related free data: **DOL OFLC H-1B LCA disclosure data** (flag.dol.gov, quarterly, public
domain) contains actual employer name + job title + offered wage + worksite.
**Lightcast Open Skills / Open Titles** — 34,000+ skills, 75,000+ standardised titles,
1,800+ occupations, free tier via request form, and better modern-tech title coverage than O*NET.

### Timezone overlap — UNSERVED

**Himalayas is the only board with a timezone facet at all**, and it is set-membership against
an employer-declared offset array (`timezoneRestrictions`, e.g. `[-10,-9,-8,-7,-6,-5,14]`),
with ~200 named zones as browse paths (`/jobs/timezones/central-european-time-cet/nodejs`,
which compose with skill and seniority). **It silently drops jobs that never declared one** —
precisely the failure our project rule exists to prevent.

RemoteOK sells timezone filtering behind a $14.95/mo paywall. Remote Rocketship and Wellfound
have none despite their reputations.

**Nobody computes overlap.** Arc.dev writes *"Min. 5 hr working overlap with Central Time"* and
*"Overlap with Pacific Time"* into job copy that nobody can filter on. Demand proven, supply zero.

Our `d_remote_scope` vocabulary already includes `timezone` as a value. It is filled on 27.6% of
jobs (country 13,790 · region 2,944 · worldwide 135) and the `timezone` case never occurs.

### Employment vehicle — W2 / 1099 / C2C / EOR — UNSERVED

Blank across all boards surveyed. Even Dice, whose users care most, leaves it in free text —
*"We are not accepting C2C or 1099 arrangements"* — which means it is regex-extractable from
descriptions exactly like our visa and clearance signals. For a US contract-market audience this
is the highest-value differentiator available.

### Union and non-union — NEAR-UNSERVED

**No job board exposes union status as a filter.** It exists in exactly two places, neither of
which is a job search:

1. **apprenticeship.gov Partner Finder** — a real **UNION/LABOR** organisation-type facet on
   `rapidsSpecifics/sponsorRTI/sponsorType`, backed by Azure Cognitive Search over 54,087 records:
   NONE 19,595 · EMPLOYER 14,112 · **UNION/LABOR 1,053** · INTERMEDIARY 736 ·
   COMMUNITY COLLEGE/UNIVERSITY 568 · BUSINESS ASSOCIATION 543 · then OTHER, CITY-COUNTY AGENCY,
   COMMUNITY BASED ORG, STATE AGENCY, FOUNDATION, FEDERAL AGENCY, WORKFORCE INVESTMENT BOARD.
   It filters apprenticeship **sponsors**, not postings, and filter state lives only in Redux —
   there is no URL parameter, so it cannot be deep-linked.
2. **Indeed** has the attribute **`SFRYX` ("Union benefits")**, which works as a URL filter
   (`sc=0kf%3Aattr%28SFRYX%29%3B`) and has **no UI control anywhere** — there is no benefits
   filter menu on Indeed at all.

> **Correction:** an earlier draft cited `D3NVR` as Indeed's union attribute. That code comes
> from Indeed's Japanese-market Job Sync table and returns zero on every live query, behaving
> identically to deliberately bogus codes. `SFRYX` is the code to use. No density count was
> ever confirmed — do not cite a number for how many Indeed jobs carry it.

**Buried in the same federal dataset:** `rapidsSpecifics/sponsorRTI/isCBA`, a facetable
collective-bargaining boolean — **3,930 sponsors true**, 33,436 false. The React app
**requests it as a facet on every single search and then discards it.** No builder method,
no UI control.

SAM.gov treats collective bargaining agreements as a first-class document type
(`"type":{"code":"CBA"}`, index `wdol-cba`) with structured `cbaNumber`, `publishDate`,
`isActive`, `revisionNumber` and county-level location, across 10,120 active wage determinations.

Prevailing wage and Davis-Bacon coverage, journeyman-versus-apprentice status, and "own tools
required" appear only as free text on every board examined. NEOGOV prints **Bargaining Unit** in
every posting header and cannot filter on it — a grep across Washington, Oregon, King County and
San Francisco portals returned **zero occurrences of "bargaining"** in served HTML.
**`schema.org/JobPosting` contains no union property**, which is the structural reason no
aggregator can facet on it.

### Collapse duplicate postings — MEASURED IN OUR DATA

**3,049 company+title pairs are duplicated across 10,164 open jobs — 16.6% of the corpus.**

| Company | Title | Copies | Distinct locations |
| --- | --- | --- | --- |
| Omadaai | Territory Partner (Field Sales) | 113 | 113 |
| Alpacahealth | Board Certified Behavior Analyst (BCBA) | 102 | 96 |
| Alpacahealth | Start an ABA Practice — BCBA | 99 | 94 |
| Renuity | Brand Ambassador | 48 | 47 |
| Bjakcareer | Android Developer — AI Finance Agent | 46 | 23 |
| Fira Health | Physical Therapist (PT) | 43 | 40 |
| Positive Development | Child Development Specialist | 41 | 41 |

CareerBuilder's retired API had **`ExcludeNational`**, which dropped "US-Nationwide" postings.
Indeed's undocumented `filter=0` is rumoured to disable duplicate collapsing `[UNVERIFIED]`.
Nothing live handles this well.

A "one posting per company + title" toggle would visibly beat LinkedIn and Indeed, which both
drown in this — and it is a `GROUP BY`, not a research project.

### Ghost and stale postings — NEAR-UNSERVED

**2,370 open jobs are over a year old** — 4.8% of live postings. Age distribution:
≤7d 5,133 · ≤30d 16,411 · ≤90d 20,764 · ≤180d 10,519 · ≤365d 6,016 · >1y 2,370.

**Remote Rocketship has a `hideGhostJobs` flag and is the only board in the survey with one.**

We already compute `d_age_days` and a `d_quality` completeness score, and `job_events` is
designed to answer "has this been open six months". It currently holds one day of history —
the filter arrives free once the daily run has been going a while.

### Sponsorship by evidence, not by prose — DATA AVAILABLE

Our `d_visa` regex fills only **3.2%** of jobs. Dice's `willingToSponsor` covers just **719 jobs,
0.86% of its inventory**. Both are near-empty because they depend on the posting saying so.

DOL's OFLC disclosure data is public domain and lists actual employer name, job title, offered
wage and worksite for every H-1B filing. That converts a 3.2%-filled regex into a hard list of
employers who have actually sponsored.

**Remote Rocketship's `visas=h1b|uk-skilled-worker` is the only program-specific sponsorship
filter anywhere.** Health eCareers has H1B and J1 Visa as job attributes. Otta asks visa
sponsorship as a **candidate requirement** per country across 8 countries.

### Also nowhere as a filter

- **Residency requirements** — NYC publishes them as free text that clusters into four clean
  groups across 2,760 postings (NYC residency within 90 days 1,466 · not required ~880 ·
  NYCHA no requirement 116 · NYS residency on first day 8)
- **Internal vs external postings** — ~48% of NYC listings are internal (External 1,434 /
  Internal 1,326). USAJOBS approximates via the `fed-internal-search` hiring path
- **Drug testing / background check** — USAJOBS records these as structured requirement codes
  and nobody filters on them
- **Days-in-office**, **interview-process length**, **equity range**, **total raised**,
  **investor name**

---

## 6. Mechanics, not filters

### A Yes/No gate before every facet — SOLVES OUR PROBLEM

Otta asks *"Do you want to work for a specific size of company?"* before showing the checkboxes,
and **disables the last unchecked box** so you cannot fake "no preference" by selecting
everything. **No preference becomes a structurally distinct state from all values selected.**

ZipRecruiter solves the same problem differently, shipping `*_explicitly_set` companion flags —
`seniority_filters_explicitly_set`, `apply_types_explicitly_set`, `employment_types_explicitly_set`,
`location_types_explicitly_set`, `radius_explicitly_set` — to distinguish "chose the default"
from "never touched it".

This is the missing UI half of our `unknowns` policy, and it is why the Reset button currently
cannot express intent.

### Query-adaptive facets — ARCHITECTURAL

**Indeed renders different filters depending on the result set.** Verified live:

| Search | Facets rendered |
| --- | --- |
| cashier, Dallas TX | Date posted · Pay · Distance · Job type · Experience level · Education · Encouraged to apply |
| software engineer, Austin TX | + **Developer skill · Clearance type · Developer type · Compensation package · Remote** |
| registered nurse, Boston MA | + **License · Specialty · Work setting · Shift and schedule** |
| warehouse, Chicago IL | + **Shift and schedule** |

Indeed's own docs confirm the rule: *"The options offered depend on the jobs available in your
search results."* There are **58+ latent attribute categories** behind it.

Built In derives its Skills facet from the current result set the same way — it is only
available once a search term or category is set. SimplyHired dynamically prunes its job-type
options to types present in the results. iHire shows only the **top 20 skill terms** for the
current result set.

We already compute leave-one-out counts for nine dimensions on every keystroke — the machinery
for this exists.

### Bands computed from the result set — EASY WIN

SimplyHired builds its salary ladder at render time from a `salaryRangeBoundaries` array in the
page props (observed: `[120000, 150000, 170000, 190000, 220000]`). No fixed ladder exists.

Our `SALARY_BANDS` are hardcoded at `<$80k / $80–120k / $120–160k / $160–200k / $200k+` — wrong
for an hourly warehouse search and wrong again for a staff-engineer search. We have the
distribution in hand at facet time.

### Preference mode: OR that widens — THE INVERSION

**Key Values** — now dead, HTTP 503 "This service has been suspended" since 2025-08-27,
unannounced — inverted the entire model:

- Multi-select was **OR, so selecting more values widened the result set**
- Companies ranked their **own top 8 values in priority order** (`numTeamValues = 8`)
- Results sorted by (1) count of overlapping tags descending, then (2) **how highly the employer
  itself ranked the value you picked** (`positionScore = numTeamValues - index`)
- Matched tags got a `.match` class on the card so you saw *which* values that team shared
- A live animated results counter updated on every toggle
- Selections persisted to `localStorage.KeyValuesTags`
- Only `numMatches === 0` hid a card — **nothing was ever excluded**

Its 51-tag culture taxonomy in 7 categories is worth mining, and several tags are
**operationally defined**, which is why they worked as filters — "Rapidly Growing Team" meant
*"team expects to hire 5+ engineers within the next 6 months"*, not a vibe. Others:
Flat Organization · EQ > IQ · Wears Many Hats · Light Meetings · Pair Programs ·
Safe Environment to Fail · Fosters Psychological Safety ·
Good for Junior Devs (*"<1 year of experience are encouraged to apply and can expect mentorship"*) ·
Internal Mobility · Promotes from Within · High Employee Retention · Self-Funded ·
Technical Founder(s) · PBC / B-Corp · Remote-OK.

Every other board in the survey treats facets as pure set intersection. This is the structural
answer to "let someone express a soft preference without silently dropping jobs", and it is the
same principle our project rule already encodes. We have a ranking engine with tunable weights
sitting beside a gating engine; offering both modes is a design decision, not a rewrite.

Otta's live equivalent: no numeric match score, just booleans — `matchesUserPreference` on
location/technology tags (highlighted green) and `meetsMinSalaryPreference` — with ML ranking
over the preference vector. Welcome to the Jungle has a *"Why is this a match?"* explainer
announced for later in 2026.

### Filter on the candidate, not the job — THE BEST ANSWER FOUND

**Handshake's *Qualifications* facet matches postings against your profile** — Major ·
School Year · Graduation Date · US Work Authorization · GPA — rather than against a value you
pick. And it handles silence correctly by construction: work authorisation includes
**`Unknown` as a selectable value**, and a student who answers "Prefer not to answer" is treated
as **fully qualified for every posting** with a work-authorisation requirement. Employers may
also choose "Don't disclose." **Silence widens the funnel instead of narrowing it.**

Aya does the same with `licenseStatesSelect` — you say which state licences you hold, and it
shows what you're eligible for. AllTruckJobs has "Only show jobs I qualify for".

This is the same principle as our `unknowns` rule, applied one level up. It is also the natural
home for the degree filter, once it means "I have at most a bachelor's".

### Three ways to handle a blank field

1. **By construction (best).** Handshake, above — silence makes you eligible.
   **apprenticeship.gov** does the same by landing blanks in an explicit, selectable `None`
   bucket (19,595 of 54,087 records).
2. **By convention (workable).** Idealist and the Chronicle of Higher Education both exclude on
   missing data at the backend — Idealist's facets compile to Algolia equality clauses — then
   mitigate by surfacing the blank as a named, selectable option: *None specified*,
   *No Education Requirement*, *Not specified*, *Commensurate with Experience*. Making the blank
   pickable is the right instinct; the default still silently drops.
3. **By imputation (wrong, instructively).** The Ladders bounds its salary slider at $100,000 in
   code (`{min: 1e5, max: 5e5}`), yet lists jobs at "$78K – $140K \*" where the asterisk marks a
   modelled *Ladders Estimate*. Jobs without employer-supplied pay get a guessed number and then
   rank against the floor — which is exactly how sub-$100K listings surface on a "$100K+" board.
   Indeed, ZipRecruiter, SimplyHired and Adzuna all do the same thing.
   **Imputation is not a safe alternative to exclusion — it just moves the error somewhere
   harder to see.**

**One footgun to avoid,** from Idealist: selecting *every* option in a facet is treated
identically to selecting none (the clause is dropped), so checking all the boxes widens rather
than narrows. Our `metros: []` convention already handles this deliberately.

### Silent exclusion, measured — THE PROOF

iHire's public API makes the cost of silent exclusion arithmetically visible.
Baseline search — electrician, Texas, 25 miles — returns **842** jobs.

- OR together **every one of the eight available** tag values → **303**.
  **539 jobs with a blank tags field are dropped without a word.**
- OR together all twenty displayed skills → **817**, not 842.
- Control: OR all six employment types → **exactly 842**. All four experience levels →
  **exactly 842**. Those are mandatory fields with no blanks.

**iHire's optional facets rule jobs out on absent evidence; its mandatory ones don't.**
Nobody using it would ever know which is which.

The same arithmetic proves its `CombinationType: 1` is OR (830 + 8 = 838 exactly) and
`CombinationType: 2` is AND (Benefits only).

**Indeed fails a third way worth designing against:** `attr()` with an unrecognised code returns
zero results and no error, so an *invalid filter* is indistinguishable from a *genuinely empty
result*. That ambiguity is what made the `D3NVR` claim unfalsifiable. **A filter that cannot
tell "no data" from "no match" from "bad query" will quietly lie to you.** Our
`normalizeProfile` already answers this — it drops unknown enum values into `warnings` rather
than silently returning nothing.

### Structured boolean without operator syntax — REFINEMENT

Adzuna splits keyword search into `what_and`, `what_phrase`, `what_or`, `what_exclude` and
`title_only` as separate labelled inputs. CareerBuilder's retired API went further with a
user-facing `BooleanOperator` = AND (default) | OR. CalCareers has a **"Use Exact Phrase Match"**
checkbox where *unchecking* expands results through O*NET occupational-group mappings.
HigherEdJobs has `OnlyTitle=1`. Indeed supports `title:` and `company:` prefixes plus `-exclude`.

Our `text` field is a raw FTS5 query, which requires the user to know FTS5.

### Saved searches that keep their filters — WORTH NOTING

Talent.com's alerts capture **only keyword and location**, dropping every active facet.
Glassdoor is reported to reset filters on saved searches `[UNVERIFIED]`. Alert frequency is
daily-or-weekly nearly everywhere; **Remote Rocketship offers hourly and is alone in that**.
Glassdoor caps alerts at 10/day and **decays frequency automatically if emails go unopened**.
LinkedIn caps at 20 active alerts.

Our profile *is* a portable JSON document, so we get this for free — it is the one place the
competition is structurally weak and we are structurally strong.

### Facet encoding patterns

- **URL path segments:** Built In (`/jobs/remote/hybrid/engineering/senior/fintech/51-200`),
  Himalayas (`/jobs/timezones/central-european-time-cet/nodejs`), RemoteOK (`/remote-dev+javascript-jobs`),
  Chronicle and Inside Higher Ed (both Madgex), Remotive, startup.jobs
- **POST body only:** Glassdoor (`jobSearchResultsQuery` BFF, `filterParams:[{filterKey,values}]`)
- **No URL state at all:** Wellfound (GraphQL `FilterConfiguration`), TrueUp,
  apprenticeship.gov (Redux), CalCareers (ASP.NET postback)
- **Opaque master container:** Indeed's `sc=0kf%3A…%3B`, which concatenates facets with no
  separators and supports `attr(A|B,or)`
- **Hard caps:** RemoteOK allows **5 simultaneous active filters** and pops your last chip with
  an `alert()`. HigherEdJobs caps JobCat at 30 and Metros at 8. Otta caps hidden industries at 30
  and level-of-role at 2, and requires exactly 3 role priorities.
- **All options checked by default:** Himalayas (Experience level and Job type — headers read
  "Deselect all"), startup.jobs (`employment_types[]`), HigherEdJobs (`PosType`, `InstType`,
  `Remote` all default-checked), ZipRecruiter (`refine_by_experience_level`)

### The gig platforms replace filtering with eligibility gating

Instawork, Wonolo and Shiftsmart expose **no URL-addressable filtered search and no saved
searches**. Worker discovery is 100% in-app.

- **Instawork:** a modal with four facets — shift types, date, position (**constrained to
  positions you're already approved for**), max distance (anchored on your profile home address,
  not GPS). ~45 fixed global positions. Six named certification types, none of them a facet
  (no OSHA 10/30, no TB test, no RBS by name anywhere in its 218-article help corpus).
  Attire is structured on the *posting* side (top wear / bottom wear / footwear / accessories,
  "Items Provided Onsite", "Restrictions") but is not worker-filterable. W-2 vs 1099 both exist
  and neither is a facet. **Hidden filter: hitting your weekly hour cap silently stops W-2 shifts
  appearing.**
- **Wonolo:** the filter control provably exists but **every option inside it is undocumented**
  `[UNVERIFIED]`. Eligibility runs on **badges**, which are a hard visibility filter —
  *"if the worker doesn't have the Badge… in most cases they won't even be able to see the job
  posting."* Badges are **customer-defined per enterprise account** (`is_soft` flag), so there
  is no fixed global certification enum.
- **Shiftsmart:** essentially no filtering — a 7-day date strip, a map with priced pins, and
  your profile address. No distance slider, no pay filter, no role multi-select, no duration
  filter. Changing search area requires editing Profile > Settings.

Sharp contrast with iHire and HigherEdJobs, where every facet is a bookmarkable URL parameter.

---

## 7. What the data allows

### Already in the database, unfiltered

| Column | Coverage | Filter it would give us |
| --- | --- | --- |
| `department` / `team` | 100% | 3,278 departments, 6,053 teams — needs alias folding like metros got |
| `comp_interval` | 37.2% | Hourly vs salaried — 1,901 hourly jobs are invisible as a class (YEAR 20,231 · HOUR 1,901 · MONTH 599 · WEEK 50 · DAY 3) |
| `comp_currency` | 37.2% | Filter and display in your own currency (USD 19,722 · EUR 1,196 · CAD 733 · GBP 726 · PLN 87 · PHP 83 · SGD 58 · AUD 51 · INR 35 …) |
| `has_equity` | 18.0% | Equity offered — 10,996 jobs. Wellfound shows it on every card |
| `d_remote_scope` | 27.6% | Remote-but-must-be-in-X (country 13,790 · region 2,944 · worldwide 135) |
| `d_salary_src` | 37.2% | Employer-stated vs reinterpreted pay |
| `d_quality` | 100% | Listing completeness — hide threadbare postings |
| company job count | 100% | Company size proxy |
| `postal_code` / `region` | 10.6% / 75% | Finer geography than metro membership |
| `d_skills` | 71.6% | Already a facet; a **negative** skills list is one new field |

### Needs a new derive pass over descriptions

All regex-over-prose, the same shape as `signals.mjs` today, against text present on 100% of
jobs: benefits and perks · employment vehicle (W2/1099/C2C/EOR) · travel percentage · shift and
schedule · days-in-office · timezone overlap · union status · prevailing wage / Davis-Bacon ·
licence and certification requirements · drug test and background check · application deadline ·
start date · "no degree required" as an explicit positive.

### Needs sources we don't sweep yet

**Our corpus is 100% Ashby, and Ashby is a local maximum.** It has the cleanest compensation and
address data of any ATS surveyed — and **no seniority, no education, no industry and no function
field at all**. Every one of those we currently infer by regex.

| ATS | What it gives that Ashby doesn't |
| --- | --- |
| **Recruitee** | `experience_code` · `education_code` · `category_code` · `salary{min,max,currency,period}` · `min_hours`/`max_hours` · three independent remote/hybrid/on_site booleans · full structured address. Richest public ATS API found. |
| **SmartRecruiters** | The only ATS with a native **industry + function + experienceLevel** triple. `locationType` query param (REMOTE/HYBRID/ONSITE). `jobAd.sections.qualifications` is a pre-separated requirements block — the best structured requirement source of any ATS. |
| **Workable** | `industry` · `function` · `experience` · `workplace` enum. (`education` is always `""`; salary and keywords are auth-only.) |
| **Personio** | `seniority` · `schedule` · **`yearsOfExperience` as a banded range** ("7-10") · two-level `occupation`/`occupationCategory` taxonomy. Unique among European ATSes. |
| **Oracle Recruiting Cloud** | Open and unauthenticated. `WorkplaceType` · `JobFamily` · `JobFunction` · `ContractType` · `JobSchedule` · `JobShift` · `ManagerLevel` · `StudyLevel` · `WorkHours` · `WorkDays` · **`DomesticTravelRequired` / `InternationalTravelRequired`**. Caveat: list response nulls almost everything; needs the detail call. |
| **Lever** | `workplaceType` enum (but 87% "unspecified" on some boards); `lists[]` gives structured Responsibilities/Requirements blocks. `commitment` is free text. |
| **Rippling** | Hands you a complete **schema.org `jsonLd` JobPosting** on every detail call — the easiest normalisation target found. Real `department_tree` hierarchy. |
| **Teamtailor** | Open RSS at `/jobs.rss` with a `tt:` namespace — `remoteStatus` plus a fully structured address. |

**Greenhouse — the obvious next target — exposes almost nothing filterable.** No employment type
anywhere in its Job Board API. `location.name` is free text carrying multiple locations with
inconsistent separators (`;`, `|`, `or`, `,`) — e.g. `"New York City, NY; San Francisco, CA |
New York City, NY"`, `"Remote, Canada; Remote, United Kingdom; Remote, United States"`,
`"SF, NYC, SEA, CHI"`. `metadata[]` is 100% customer-defined and non-standardisable.
`education` is rare (32/51 on Discord, 0/517 on Anthropic). **On filter-precision grounds,
Recruitee and SmartRecruiters are worth more than Greenhouse.**

**Workday** is a trap for a different reason: facet parameter names **vary per tenant**. Country
and state appear under at least six different names across ten tenants; Red Hat uses single
letters (`a`, `b`, `c`, `d`, `e`); Salesforce uses
`CF_-_REC_-_LRV_-_Job_Posting_Anchor_-_Country_from_Job_Posting_Location_Extended`. Never
hardcode facet names — discover per tenant. There is no salary field anywhere in the CxS API,
and `postedOn` is a localised display string ("Posted 10 Days Ago"), never a date.

**iCIMS and SuccessFactors are effectively closed** — no viable unauthenticated feed.

### Architectural note for our filter rule

ATSes conflate *absent*, *null*, and *not-configured*. Workable's `education` is always `""`.
Recruitee's `salary` is always an object with null members unless configured. BambooHR's entire
`atsLocation` is null while the parallel `location` is populated. Workday's `timeType` and
`remoteType` vary **by tenant**, not by job.

In every one of these cases a blank means "the customer never configured this field", never
"this job fails the criterion". Our normalisation layer should carry an explicit three-state —
`present` / `absent` / **`not-supported-by-source`** — rather than collapsing the last two into
NULL, so the filter layer can honour the rule without re-deriving provenance.

### Standard taxonomies worth adopting

| Taxonomy | What it is | Licence |
| --- | --- | --- |
| **O*NET 30.3 / O*NET-SOC 2019** | 1,016 occupations; `Job Titles.xlsx` has **57,543 lay titles → SOC**; 23 SOC major groups as job families | CC BY 4.0 |
| **BLS OEWS (May 2025)** | Wage percentiles by SOC × MSA | Public domain |
| **DOL OFLC** | Real employer + title + offered wage + worksite for H-1B filings | Public domain |
| **NAICS 2022** | Industry, 2–6 digit hierarchy (NAICS 2027 lands Jan 2027) | Public domain |
| **ESCO v1.2.1** | 3,039 occupations, ~13,900 skills, 28 languages, ISCO-08 aligned | EC open data |
| **ISCO-08** | The pivot for US↔EU crosswalks | Public |
| **Lightcast Open Skills/Titles** | 34,000+ skills, 75,000+ titles; better modern-tech coverage than O*NET | Free tier, request form |

Avoid LinkedIn's industry taxonomy v2 as a product taxonomy — it is published as API reference
documentation for LinkedIn API partners and using it outside that context is legally grey.
Use NAICS as canonical and keep LinkedIn IDs only as an interop mapping.

---

## 8. Ordered by cost

### Markup only — the engine already does this

- **Degree, visa sponsorship, clearance, company allow-list.** Four panels. Fields, columns and
  query support all exist.
- **The unknown-policy controls.** `UNKNOWNABLE` is already served to the page with labels,
  shares and defaults, specifically so the controls can be generated from it.
- **Sort.** Expose recency, salary, quality and title-match — the weights exist in
  `DEFAULT_WEIGHTS`.
- **Hourly vs salaried; currency; equity; remote scope.** Four columns already populated and
  never surfaced.
- **Collapse duplicate postings.** A `GROUP BY company_id, title_norm` toggle against a measured
  16.6% of the corpus.

### A derive pass — hours, not weeks

- **Benefits and perks facet.** A `SKILL_TERMS`-shaped list over text present on every job.
- **Employment vehicle — W2 / 1099 / C2C / EOR.** Unserved by every board. One pattern list.
- **Days-in-office and timezone overlap.** Both stated in prose today and filtered by nobody.
- **Department and team as facets.** 100% filled; needs the alias folding metros already got.
- **Result-set-derived salary bands.** Replace the hardcoded ladder with one computed at facet time.
- **Degree as "this level or lower".** Fix the semantics, not just the control. No board
  implements this — it is open design space.
- **Clearance as a graded level; travel as buckets.** USAJOBS proves both taxonomies.
  `CLEARANCE_RE` already distinguishes *top secret* from *public trust* and throws it away.
- **Union, prevailing wage, drug test, background check.** All free text on every board examined.

### Real projects

- **O*NET title normalisation + BLS OEWS percentiles.** Unlocks pay-vs-market filtering, a real
  occupation taxonomy, and a free salary benchmark. The highest-ceiling item here.
- **Sweep Recruitee, SmartRecruiters, Personio, Oracle ORC.** Buys natively structured seniority,
  education, industry, function and travel — fields Ashby does not have.
- **Query-adaptive facet rail.** Render facets by prevalence in the result set rather than a
  fixed thirteen.
- **Preference mode alongside filter mode.** The Key Values inversion: OR that widens, ranked by
  mutual fit, nothing excluded.
- **DOL OFLC sponsorship data.** Turns a 3.2%-filled regex into a verified employer list.
- **Company enrichment.** Size, funding stage, public/private, B-Corp. Requires a data source
  decision.

---

## Appendix — board-by-board notes worth keeping

### LinkedIn gutted its own facets in 2026

Live probing (logged out) against a 126-result baseline found only four facets still filtering:
`f_TPR` (date), `f_C` (company), `f_AL`, `f_EA`. `f_E` (experience), `f_JT` (job type),
`f_WT` (workplace), `f_SB2` (salary), `f_I`, `f_F`, `f_T` and `f_VJ` are **parsed but ignored** —
`f_E=6`, `f_JT=F` and `f_WT=1` return byte-identical result sets to each other. Signed-in
behaviour is `[UNVERIFIED]`.

Power-user hack that still works: **`f_TPR=r<any seconds>`** gives sub-24-hour windows
(`r3600` = past hour, `r900` = past 15 minutes), not exposed in the UI.

LinkedIn cannot exclude companies, exclude keywords, or hide promoted posts.

### Aggregators are usually worse than the boards they aggregate

**Talent.com** has six facets, all **strictly single-select** (OR is impossible within a facet),
**no salary filter**, **no sort control**, **no facet counts**, and — despite being an
aggregator — **no source facet and no way to hide promoted listings**. Its radius value is always
in km even when the UI shows miles. Its facet rail varies by country domain in three tiers.

**Monster and CareerBuilder are now the same Next.js app** (Bold Holdings, post-Chapter-11 2025).
Four filters, no sort (`orderBy` hardcoded to `"relevance"`), no salary filter. Their Remote
toggle **ORs into the employment-type array** rather than intersecting — an anti-pattern.
Untyped postings are silently dropped when any job type is selected.

**ZipRecruiter** has a closed set of exactly six `refine_by_*` params, **no sort control at all**,
and result counts that are fuzzy estimates which can *exceed* the unfiltered baseline
(`employment_type:full_time` reported 844 against a 500 baseline). Do not trust its counts.

### Consolidation — 13 logos, ~9 products

RemoteOK, We Work Remotely, Arc, Toptal, PeoplePerHour and NoDesk now sell as one $29.95
"TopAccess" bundle. FlexJobs and Remote.co share a single search backend (identical param
vocabulary). SimplyHired runs on Indeed's backend (`prod.statics.indeed.com/simplyhired/`).
Glassdoor and Indeed merged logins in November 2025. Monster and CareerBuilder are one app.

### Dead or dying

- **Key Values** — HTTP 503 since 2025-08-27, unannounced. Taxonomy recovered from Wayback.
- **Stack Overflow Jobs** — shut down March 2022. Still the best tech-stack filter ever shipped.
- **Hired / Vettery** — `hired.com` 301s to `lhh.com`. Candidate marketplace no longer operates.
- **Welcome to the Jungle's public faceted job search** — as of Aug 2026 the English site returns
  a count and a "Match me to jobs" button with no results list and no facets without an account.
  Its **company** search is still fully faceted.
- **CareerOneStop's Apprenticeship Finder** — both URLs 404.

### Access techniques that worked

Imperva/Incapsula and Cloudflare routinely protect HTML routes while leaving the site's own
JSON/XHR endpoints and static JS wide open. Pull a JS asset, read the `fetch`/`$.ajax` URLs out
of it, hit those directly. That is how HigherEdJobs' 335-metro list, iHire's entire facet schema,
Vivian's Algolia index and apprenticeship.gov's Azure index all fell out. Two corollaries: always
`curl --compressed` (Wayback's `id_` raw mode returns gzip bytes that otherwise look like an
empty page), and some APIs require a POST body (`-d ''`) or they return HTTP 411.

### Coverage gaps

- **Snagajob and Wonolo** resisted every access route; option values unknown.
- **Glassdoor** keeps facets in POST bodies, so some encodings remain provisional. **Whether its
  `minRating` drops unrated companies is the most consequential open question left in the
  survey.** Also unresolved: whether `includeNoSalaryJobs` is user-facing, and whether its salary
  filter matches Glassdoor estimates or only employer-posted pay.
- **Vivian's** URL parameter spellings — its filters are client-side Algolia refinements and SSR
  counts do not respond to query params.
- **Handshake's** URL parameter names — the app is Cloudflare-gated.
- **PracticeLink's** option values for Immigration Assistance, Loan Assistance, Employment Type
  and Practice Type.
- Not examined: Texas / New York State / Washington State government boards, individual union
  locals, NABTU, aflcio.org (403).
