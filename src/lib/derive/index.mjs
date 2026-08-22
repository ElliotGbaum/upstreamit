/**
 * One job in, every `d_*` column out.
 *
 * This is the only place that knows the derivations exist together; each module
 * beside it stays independently testable. Order matters in exactly two places:
 * location runs before workplace (the location text is the fallback when the
 * workplace enum is missing), and both run before signals (which scores how
 * much a listing actually told us).
 *
 * Pure function of its inputs — no database, no clock beyond the `now` passed
 * in. That is what makes re-deriving 61,213 jobs after a table edit a
 * seconds-long operation with no network and no ambiguity about what changed.
 */

import { deriveLocation, deriveRemoteScope } from './location.mjs';
import { deriveWorkplace } from './workplace.mjs';
import { deriveSalary } from './salary.mjs';
import { deriveSeniority } from './seniority.mjs';
import { deriveJobFunction } from './job-function.mjs';
import { deriveSignals, ageDays } from './signals.mjs';

export function deriveJob(job, description, now = Date.now()) {
  const location = deriveLocation(job);
  const { workplace, src: workplaceSrc } = deriveWorkplace(job, location);
  const salary = deriveSalary(job);
  const seniority = deriveSeniority(job, description);
  const jobFunction = deriveJobFunction(job);
  const signals = deriveSignals(job, description, {
    salary_known: salary.salary_known,
    years_known: seniority.known,
    workplace,
    metros: location.metros,
  });

  return {
    d_workplace: workplace,
    d_workplace_src: workplaceSrc,
    d_remote_scope: workplace === 'remote' ? deriveRemoteScope(location) : null,
    d_metros: JSON.stringify(location.metros),
    d_countries: JSON.stringify(location.countries),
    d_salary_min: salary.salary_min,
    d_salary_max: salary.salary_max,
    d_salary_known: salary.salary_known,
    d_salary_src: salary.salary_src,
    d_min_years: seniority.min,
    d_max_years: seniority.max,
    d_years_known: seniority.known,
    d_seniority: seniority.seniority,
    d_seniority_src: seniority.src,
    d_job_function: jobFunction,
    d_skills: JSON.stringify(signals.skills),
    d_visa: signals.visa,
    d_clearance: signals.clearance,
    d_degree: signals.degree,
    d_age_days: ageDays(job.posted_at, now),
    d_quality: signals.quality,
    d_derived_at: now,

    // Not columns — consumed by the driver for the join tables and the
    // unmatched-location report.
    _metros: location.metros,
    _skills: signals.skills,
    _unmatched: location.unmatched,
    _cities: location.cities,
  };
}

export { deriveLocation, deriveWorkplace, deriveSalary, deriveSeniority, deriveJobFunction, deriveSignals };
