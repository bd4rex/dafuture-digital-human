import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Review regressions execute their assertions in both modes. The strict gate
// removes their TODO designation so unresolved findings fail the process.
const result = spawnSync(process.execPath, ['--test'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, REVIEW_STRICT: '1' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
