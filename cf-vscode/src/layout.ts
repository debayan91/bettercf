import * as vscode from 'vscode';

/**
 * Column ratios required by the cockpit layout: statement / editor / runner.
 * `vscode.setEditorLayout` expects sizes that sum to 1 within a row or group.
 */
const COLUMN_SIZES = [0.3, 0.45, 0.25];

interface EditorLayoutGroup {
  groups: Array<{ size: number }>;
}

/**
 * Enforces the three-column split (30% / 45% / 25%).
 *
 * `vscode.setEditorLayout` replaces the whole workbench grid, so applying it while the
 * statement panel and the runner terminal already live in columns 1 and 3 is what keeps
 * everything anchored. It is invoked again after each navigation because opening a file
 * can grow the grid (VS Code appends a column when the referenced column does not exist).
 */
export async function enforceThreeColumnLayout(): Promise<void> {
  const layout: EditorLayoutGroup = {
    groups: COLUMN_SIZES.map((size) => ({ size })),
  };
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
  } catch {
    // Some VS Code forks do not expose the command; the extension still works, just looser.
  }
}

/**
 * Applies the layout and makes sure VS Code's grid actually has three groups. The grid only
 * materialises columns that contain tabs, so the caller is expected to have created the
 * statement panel (column 1), the text editor (column 2) and the runner terminal (column 3)
 * before calling this.
 */
export async function applyCockpitLayout(): Promise<void> {
  await enforceThreeColumnLayout();
  // A second application settles the ratio after VS Code re-parents the newly created tabs.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await enforceThreeColumnLayout();
}
