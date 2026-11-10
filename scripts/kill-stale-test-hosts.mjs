/**
 * Kills VS Code instances left over from crashed/hung integration test runs.
 * Every @vscode/test-electron run launches a full VS Code window; a run that
 * dies mid-flight orphans its instance and they accumulate ("more and more
 * test windows"). We kill ONLY instances whose command line marks them as
 * test hosts for this project (.vscode-test dir / extensionTestsPath) —
 * never the user's own VS Code windows.
 *
 * Safe to run when nothing is stale: it exits 0 either way.
 */
import { execFileSync } from 'node:child_process';

const MARKERS = ['--extensionTestsPath', '.vscode-test'];

function findStaleInstances() {
  let stdout;
  try {
    stdout = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
  } catch {
    return [];
  }
  if (!stdout.trim() || stdout.trim() === 'null') {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => {
      const processId = p?.ProcessId;
      const cmd = p?.CommandLine;
      if (typeof processId !== 'number' || typeof cmd !== 'string') {
        return false;
      }
      // Test instances reference the dev extension path AND either the test
      // extension path or the .vscode-test profile directory.
      const isJetGitDev = cmd.includes('jetgit') && (cmd.includes('--extensionDevelopmentPath') || cmd.includes('.vscode-test'));
      const isTestRun = MARKERS.some((m) => cmd.includes(m));
      return (isJetGitDev && isTestRun) || (cmd.includes('.vscode-test') && isTestRun);
    })
    .map((p) => ({ processId: p.ProcessId, commandLine: p.CommandLine }));
}

const stale = findStaleInstances();
if (stale.length === 0) {
  console.log('[kill-stale] no stale test VS Code instances');
} else {
  for (const instance of stale) {
    console.log(`[kill-stale] terminating test instance pid=${instance.processId}`);
    try {
      execFileSync('taskkill', ['/PID', String(instance.processId), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  console.log(`[kill-stale] terminated ${stale.length} stale instance(s)`);
}

