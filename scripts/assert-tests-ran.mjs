/**
 * A run that executed nothing is a failure, whatever the runner says.
 *
 * `passWithNoTests: false` is not enough, and the difference is the whole
 * point: it covers "no test FILES were found". It does not cover files found
 * and every test inside them filtered out, which exits 0 with a skip count.
 * Measured on this repository — `vitest run --testNamePattern zzz` reports
 * `285 skipped` and returns 0.
 *
 * That is exactly how a sibling repository shipped with its entire suite
 * skipped: a `testNamePattern` written as a path matched no test NAME, so
 * every test was filtered out and continuous integration read the exit code.
 */
import {readFileSync, rmSync} from 'node:fs';

const path = process.argv[2] ?? '.vitest-result.json';
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`could not read the run report at ${path}: ${error.message}`);
  process.exit(1);
}
rmSync(path, {force: true});

const total = report.numTotalTests ?? 0;
const ran = (report.numPassedTests ?? 0) + (report.numFailedTests ?? 0);

if (total === 0) {
  console.error('the run selected no tests at all');
  process.exit(1);
}
if (ran === 0) {
  console.error(
    `the run selected ${total} test(s) and executed none of them — ` +
      'every one was skipped, which is not a pass',
  );
  process.exit(1);
}
console.log(`${ran} of ${total} test(s) executed`);
