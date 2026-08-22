/**
 * Coarse job function, from title first and department second.
 *
 * Why not just use `department`? It is present on 100% of jobs but holds **464
 * distinct values** — free text posing as an enum, with every board inventing
 * its own vocabulary ("GTM", "Go To Market", "Revenue", "Commercial" all mean
 * sales). Title is the more consistent signal, so department is only consulted
 * when the title says nothing.
 *
 * Rules are ordered and first-match-wins, so the specific ones lead. `other` is
 * a real answer, not a failure: this exists to give the UI a usable top-level
 * cut, not to be a taxonomy.
 */

import { fold, termRegex } from './text.mjs';

const RULES = [
  ['customer-success', ['customer success', 'customer experience', 'account management', 'account manager', 'client services', 'client success', 'implementation', 'deployment', 'onboarding', 'solutions consultant', 'solutions architect', 'solutions engineer', 'sales engineer', 'technical account', 'support engineer', 'customer support', 'technical support', 'renewals', 'customer operations']],
  ['sales', ['sales', 'account executive', 'business development', 'bdr', 'sdr', 'revenue', 'partnerships', 'channel', 'go to market', 'gtm', 'commercial', 'inside sales', 'field sales', 'enterprise sales']],
  ['marketing', ['marketing', 'growth', 'demand generation', 'brand', 'content', 'seo', 'communications', 'pr', 'social media', 'copywriter', 'campaign', 'community']],
  ['data', ['data scientist', 'data science', 'data engineer', 'data analyst', 'analytics', 'machine learning', 'ml engineer', 'ai engineer', 'business intelligence', 'bi ', 'data platform', 'analytics engineer', 'statistician']],
  ['research', ['research scientist', 'research engineer', 'researcher', 'research associate', 'scientist', 'r&d']],
  ['security', ['security', 'appsec', 'infosec', 'soc analyst', 'penetration', 'threat', 'trust and safety', 'trust & safety', 'grc', 'compliance engineer']],
  ['it', ['it ', 'information technology', 'helpdesk', 'help desk', 'system administrator', 'sysadmin', 'network engineer', 'desktop support']],
  ['engineering', ['engineer', 'engineering', 'developer', 'programmer', 'sre', 'devops', 'architect', 'qa', 'quality assurance', 'test engineer', 'mobile', 'frontend', 'front end', 'backend', 'back end', 'full stack', 'fullstack', 'platform', 'infrastructure', 'firmware', 'embedded']],
  ['design', ['designer', 'design', 'ux', 'ui ', 'user experience', 'user research', 'creative', 'illustrator', 'motion']],
  ['product', ['product manager', 'product management', 'product owner', 'product lead', 'technical product', 'product operations', 'product marketing']],
  ['finance', ['finance', 'financial', 'accountant', 'accounting', 'controller', 'fp&a', 'treasury', 'audit', 'tax', 'payroll', 'bookkeep', 'investment', 'underwrit']],
  ['legal', ['legal', 'counsel', 'attorney', 'lawyer', 'paralegal', 'contracts', 'privacy']],
  ['people', ['recruiter', 'recruiting', 'talent', 'people operations', 'people ops', 'human resources', 'hr ', 'hrbp', 'compensation', 'benefits', 'learning and development']],
  ['healthcare', ['nurse', 'rn ', 'physician', 'clinical', 'medical', 'therapist', 'pharmacist', 'behavior analyst', 'bcba', 'caregiver', 'dental', 'veterinar', 'patient']],
  ['education', ['teacher', 'tutor', 'instructor', 'professor', 'curriculum', 'education', 'academic', 'school']],
  ['science', ['biolog', 'chemist', 'physicist', 'laborator', 'lab technician', 'bioinformatic', 'genomic']],
  ['manufacturing', ['manufacturing', 'production', 'assembler', 'machinist', 'fabrication', 'welder', 'industrial', 'mechanical engineer', 'electrical engineer', 'process engineer', 'quality inspector', 'maintenance technician']],
  ['construction', ['construction', 'foreman', 'estimator', 'superintendent', 'electrician', 'plumber', 'hvac', 'installer', 'carpenter', 'roofer']],
  ['logistics', ['logistics', 'supply chain', 'warehouse', 'driver', 'dispatcher', 'fleet', 'procurement', 'inventory', 'shipping', 'fulfillment']],
  ['hospitality', ['chef', 'cook', 'server', 'bartender', 'barista', 'housekeep', 'hotel', 'restaurant', 'concierge', 'front desk']],
  ['retail', ['retail', 'store manager', 'sales associate', 'cashier', 'merchandis', 'stylist']],
  ['media', ['journalist', 'editor', 'producer', 'video', 'photographer', 'podcast', 'broadcast']],
  ['operations', ['operations', 'ops', 'program manager', 'project manager', 'chief of staff', 'strategy', 'business operations', 'bizops', 'strategist', 'analyst', 'consultant', 'coordinator', 'administrator', 'executive assistant', 'office manager']],
];

const COMPILED = RULES.map(([fn, terms]) => [fn, termRegex(terms, '')]);

export function deriveJobFunction(job) {
  const title = fold(job.title);
  for (const [fn, re] of COMPILED) if (re && re.test(title)) return fn;
  const dept = fold(`${job.department ?? ''} ${job.team ?? ''}`);
  for (const [fn, re] of COMPILED) if (re && re.test(dept)) return fn;
  return 'other';
}
