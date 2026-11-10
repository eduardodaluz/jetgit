/**
 * M1 integration smoke: the extension activates, contributes its views, and
 * degrades gracefully. Feature suites are added per milestone.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('M1 activation', () => {
  test('extension activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension('webne.jetgit');
    assert.ok(ext, 'JetGit extension must be present in the development host');
    await ext.activate();
    assert.ok(ext.isActive, 'extension should be active');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('jetgit.showLog'), 'jetgit.showLog must be registered');
    assert.ok(commands.includes('jetgit.changelists.commit'), 'changelist commands must be registered');
  });
});
