/**
 * The remaining description-derived signals: skills, visa, clearance, degree,
 * age, and a listing-quality score.
 *
 * Everything here reads `descriptionPlain`, which is present on 100% of jobs and
 * averages ~5 KB — so all of it runs in one pass per job over pre-folded text,
 * with the term lists compiled to single alternations at module load. Compiling
 * per job instead cost minutes at 61k rows, and the corpus is several times that.
 */

import { fold, termRegex } from './text.mjs';

/**
 * Skills worth filtering on. Deliberately finite: this is a facet list for a UI,
 * not an ontology. Ambiguous bare tokens (`r`, `go`, `c`) are excluded — with
 * word-boundary matching `go` still catches "Go" the language, but it also
 * catches every "go-to-market", and the noise is not worth the recall.
 */
export const SKILL_TERMS = [
  'python', 'javascript', 'typescript', 'java', 'kotlin', 'swift', 'ruby', 'rails',
  'php', 'scala', 'rust', 'golang', 'c++', 'c#', '.net', 'objective-c', 'perl', 'elixir',
  'react', 'react native', 'angular', 'vue', 'svelte', 'next.js', 'node.js', 'django',
  'flask', 'fastapi', 'spring boot', 'graphql', 'rest api', 'grpc',
  'aws', 'azure', 'gcp', 'google cloud', 'kubernetes', 'docker', 'terraform', 'ansible',
  'jenkins', 'ci/cd', 'linux', 'serverless', 'microservices',
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'snowflake',
  'databricks', 'bigquery', 'redshift', 'spark', 'hadoop', 'kafka', 'airflow', 'dbt', 'etl',
  'machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow',
  'scikit-learn', 'pandas', 'numpy', 'llm', 'large language models', 'generative ai',
  'rag', 'prompt engineering', 'langchain', 'hugging face', 'mlops',
  'tableau', 'power bi', 'looker', 'excel', 'google sheets', 'sigma', 'mode',
  'salesforce', 'hubspot', 'marketo', 'outreach', 'salesloft', 'gong', 'zendesk',
  'servicenow', 'jira', 'confluence', 'asana', 'notion', 'airtable', 'zapier',
  'netsuite', 'workday', 'sap', 'oracle', 'quickbooks', 'stripe', 'segment', 'amplitude',
  'mixpanel', 'google analytics', 'braze', 'iterable', 'intercom', 'twilio',
  'figma', 'sketch', 'adobe', 'photoshop', 'illustrator', 'after effects', 'canva',
  'webflow', 'wordpress', 'shopify', 'contentful',
  'agile', 'scrum', 'kanban', 'six sigma', 'lean', 'pmp', 'prince2', 'itil',
  'soc 2', 'hipaa', 'gdpr', 'pci', 'iso 27001', 'sox',
  'cpa', 'cfa', 'series 7', 'bcba', 'rn', 'cissp', 'ccna', 'aws certified',
  'autocad', 'solidworks', 'revit', 'matlab', 'labview', 'plc',
];

const SKILLS_RE = termRegex(SKILL_TERMS, 'g');

/** Sponsorship. The negative is checked first — "we do not sponsor" contains "sponsor". */
// Sentence-bounded: `[^.]{0,40}` cannot cross a full stop, so "This role is not
// remote. Sponsorship is available." does not read as a refusal, while every
// real phrasing does — "unable to provide visa sponsorship", "we do not offer
// sponsorship at this time", "cannot sponsor work visas".
const VISA_NO = /\b(?:not|no|cannot|can not|can't|unable|do(?:es)? not|will not|won't|without|ineligible)\b[^.]{0,40}?\bsponsor/;
const VISA_YES = /\b(?:visa sponsorship (?:is )?(?:available|offered|provided)|we (?:can |do |will )?sponsor|sponsorship (?:is )?available|will sponsor|h-?1b (?:transfer|sponsor)|open to sponsor)/;

const CLEARANCE_RE = /\b(?:security clearance|ts\/sci|top secret|secret clearance|public trust|dod clearance|active clearance|polygraph)\b/;

const DEGREE_RULES = [
  ['phd', /\b(?:ph\.?d|doctorate|doctoral)\b/],
  ['masters', /\b(?:master'?s?(?: degree)?|m\.?s\.?c?\b|mba|m\.?eng)\b/],
  ['bachelors', /\b(?:bachelor'?s?(?: degree)?|b\.?s\.?c?\b|b\.?a\.?\b|undergraduate degree|four[- ]year degree)\b/],
  ['none', /\b(?:no degree (?:required|necessary)|degree not required|in lieu of a degree|or equivalent experience|equivalent practical experience|high school diploma)\b/],
];

export function deriveSignals(job, description, { salary_known, years_known, workplace, metros }) {
  const text = fold(description);

  const skills = [];
  if (SKILLS_RE && text) {
    SKILLS_RE.lastIndex = 0;
    for (const m of text.matchAll(SKILLS_RE)) skills.push(m[0]);
  }

  let visa = null;
  if (text) {
    if (VISA_NO.test(text)) visa = 0;
    else if (VISA_YES.test(text)) visa = 1;
  }

  let degree = null;
  if (text) {
    for (const [level, re] of DEGREE_RULES) {
      if (re.test(text)) { degree = level; break; }
    }
  }

  // Completeness, not desirability — "can a filter reason about this listing?"
  // Used to break ties in ranking and to warn on threadbare postings, never to
  // exclude: a sparse listing at a company you want is still a job.
  const parts = [
    description && description.length > 400,
    salary_known === 1,
    years_known === 1,
    workplace !== 'unknown',
    metros.length > 0,
    Boolean(job.employment_type),
    Boolean(job.department),
    Boolean(job.posted_at),
  ];
  const quality = parts.filter(Boolean).length / parts.length;

  return {
    skills: [...new Set(skills)].sort(),
    visa,
    clearance: text && CLEARANCE_RE.test(text) ? 1 : null,
    degree,
    quality: Math.round(quality * 100) / 100,
  };
}

/** Days since posting. Recomputed every derive run, which is why it is a column. */
export function ageDays(postedAt, now) {
  if (!postedAt) return null;
  return Math.max(0, Math.round((now - postedAt) / 86_400_000));
}
