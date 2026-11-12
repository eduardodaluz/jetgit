/**
 * M1 integration smoke: the extension activates, contributes its views, and
 * degrades gracefully. Feature suites are added per milestone.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('M1 activation', () => {
  test('extension activates and registers its commands', async () => {
    // Resolved from package.json so a publisher change can't stale this test.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { publisher: string; name: string };
    const ext = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    assert.ok(ext, 'JetGit extension must be present in the development host');
    await ext.activate();
    assert.ok(ext.isActive, 'extension should be active');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('jetgit.showLog'), 'jetgit.showLog must be registered');
    assert.ok(commands.includes('jetgit.changelists.commit'), 'changelist commands must be registered');
  });
});
