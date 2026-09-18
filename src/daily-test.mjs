/**
 * The daily pipeline's one decision: whether the run it just finished may be
 * put on the live site.
 *
 * Everything else in daily.mjs is a sequence of child processes and a report,
 * which the scripts it runs test for themselves. The publish stage is
 * different in kind — it is the only stage whose mistake other people see —
 * so its gate is pinned here on the cases that have to hold: a look
 * (`--report-only`, `--skip-sweep`) never uploads, a run where nothing was
 * swept never uploads, a failed derivation holds the upload, and one failed
 * sweep among four does not.
 */

import { STAGES, publishGate } from './daily.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

const ran = (key, ok = true) => ({ key, ok, skipped: false });
const skipped = (key) => ({ key, ok: true, skipped: true });
const fourSweeps = (ok = [true, true, true, true]) => ok.map((o) => ran('sweep', o));

// -------------------------------------------------------------- the order --
{
  const keys = STAGES.map((s) => s.key);
  check('publish is the last stage', keys.at(-1), 'publish');
  check('publish comes after every sweep and derive', keys.lastIndexOf('derive') < keys.indexOf('publish') && keys.lastIndexOf('sweep') < keys.indexOf('publish'), true);
  const publish = STAGES.at(-1);
  check('publish runs the same script a person would', publish.command, ['/bin/sh', 'deploy/upload-db.sh']);
}

// --------------------------------------------------------------- the gate --
{
  check('a full clean run publishes', publishGate([...fourSweeps(), ran('derive'), ran('derive'), ran('enrich')]), null);
  check('one failed sweep among four still publishes', publishGate([...fourSweeps([true, false, true, true]), ran('derive'), ran('derive')]), null);
  check('a failed enrich does not hold the upload', publishGate([...fourSweeps(), ran('derive'), ran('derive'), ran('enrich', false)]), null);
  check('a failed derivation holds it', typeof publishGate([...fourSweeps(), ran('derive', false), ran('derive')]), 'string');
  check('a failed metro rebuild holds it too (same key)', typeof publishGate([...fourSweeps(), ran('derive'), ran('derive', false)]), 'string');
  check('every sweep skipped: nothing to publish', typeof publishGate([skipped('sweep'), skipped('sweep'), skipped('sweep'), skipped('sweep'), ran('derive')]), 'string');
  check('every sweep failed: nothing to publish', typeof publishGate([...fourSweeps([false, false, false, false]), ran('derive')]), 'string');
  check('no stages at all (report-only): nothing to publish', typeof publishGate([]), 'string');
  check('a skipped derive is not a failed one', publishGate([...fourSweeps(), skipped('derive'), skipped('derive')]), null);
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} daily checks passed`);
