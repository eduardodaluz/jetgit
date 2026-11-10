import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    ui: 'tdd',
    timeout: 30_000,
  });
  const testsRoot = path.resolve(__dirname, '.');
  return new Promise((resolve, reject) => {
    // Test files exist as individual transpiled .js files next to this index
    // (esbuild builds tests with bundle:false — see esbuild.js). mocha.loadFiles
    // emits the pre-require event that binds suite/test into scope.
    for (const entry of fs.readdirSync(testsRoot)) {
      if (entry.endsWith('.test.js')) {
        mocha.addFile(path.resolve(testsRoot, entry));
      }
    }
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
