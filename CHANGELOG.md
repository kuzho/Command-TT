# Change Log

## [1.0.0] - 2026-03-31

### Added
- Variable types in the Variables panel: `text`, `select`, `checkbox`, and `date`.
- Type-aware controls in variable rows:
	- `text`: free text input.
	- `select`: dropdown values from comma-separated options.
	- `checkbox`: exactly 2 options and toggle behavior.
	- `date`: native date picker.
- Variable rows now include explicit Edit and Delete actions.
- Variable labels are shown visually as `${name}` for easier copy/use in commands.

### Changed
- Variables are normalized for better backward compatibility with existing settings.
- Variable editing flow now supports changing variable name, type, value, and folder from Edit.
- Text variable values update inline for faster editing.

### Fixed
- Renaming folders now correctly handles the synthetic `Ungrouped` folder in Variables.
- Renaming folders now correctly handles the synthetic `Ungrouped` folder in Commands.

## [0.0.9] - 2026-03-25

### Changed
- Lowered minimum VS Code engine requirement to `^1.107.0` for compatibility with Antigravity 1.107.0.

## [0.0.7] - 2026-03-13

### Added
- **Variables webview**: Declared `"type": "webview"` in the view contribution so VS Code renders the Variables panel correctly.
- **Title bar actions – Variables**: Added Add Variable (+), Add Folder, and Refresh icons to the Variables view header.
- **Title bar actions – Commands**: Added Add Command (+), Add Folder, and Refresh icons to the Commands view header.
- **Folder actions – Variables**: Each variable folder now shows inline Add Variable, Add Subfolder, Rename, and Delete buttons.
- **Folder actions – Commands**: Each command folder now shows inline Add Command, Add Subfolder, Rename, and Delete buttons.
- **Command folder management**: New commands `commandTT.addCommandGroup`, `commandTT.renameCommandGroup`, and `commandTT.deleteCommandGroup` to create, rename, and delete command folders.
- **Folder-add icon**: New `folder-add` SVG icon (light/dark) used for all Add Folder actions.
- **View icons**: Variables view uses `add.svg` icon; Commands view uses `run.svg` icon in the sidebar.

### Changed
- **Folder collapse**: Clicking anywhere on a folder header now toggles expand/collapse, not just the chevron.
- **Variable tooltips**: Tooltip on the name field shows the variable name; tooltip on the value field shows the variable value. Removed `description` from tooltip logic.
- **Removed variable description**: The `description` field is no longer prompted, saved, or displayed for variables. Existing `description` values in settings are silently ignored.
- **Removed advanced-edit pencil**: The edit (pencil) icon was removed from individual variable rows.
- **No-op save guard**: Variable rows no longer trigger a config write when name and value are unchanged, preventing unwanted re-renders.
- **Performance**: Removed wildcard `activationEvents: ["*"]`; VS Code now auto-generates activation from contribution declarations.

### Fixed
- **Add Command with group context**: `commandTT.addCommand` now pre-fills the group field when invoked from a folder item.
- **Variable grid columns**: Adjusted grid-template-columns to match the removed pencil button (8 → 7 columns).
- **Body spacing**: Reduced webview body padding for a tighter, closer-to-edge layout.

## [0.0.6] - 2026-02-17

### Added
- **Variable Grouping**: Variables can now be organized into nested groups using the `/` separator (e.g., `Environment/Production`), similar to commands.
- **Group Persistence**: The expanded/collapsed state of folders in both Commands and Variables views is now persistent across sessions.
- **Command Configuration**: The `sendNewLine` option (execute immediately) is now exposed in the "Add/Edit Command" wizard flow.

## [0.0.5] - 2026-02-12

### Maintenance
- Updated `eslint` to v9 and `typescript-eslint` to v8.
- Migrated linter configuration to `eslint.config.mjs`.
- Updated dependencies to resolve security vulnerabilities.
- Code cleanup: removed unused variables.

## [0.0.4] - 2026-02-12

### Fixed
- Removed debug output from variable substitution process.

## [0.0.3] - 2026-02-12

### Added
- Variable options with QuickPick selection: Variables can now have multiple selectable options via `options` array in settings.
- Sort order configuration: New `sortOrder` setting to display variables and commands either by settings order (default) or alphabetically.
- Expansion state persistence: The Commands tree now remembers which groups/folders are expanded or collapsed across sessions.
- Improved activity bar icon: Enhanced `<_` symbol sizing and spacing for better visual prominence.

### Fixed
- Extension compilation and debugging workflow to work correctly with F5 development mode.

## [0.0.2] - 2026-02-10

- Send Enter setting is now per command via sendNewLine (defaults to true).

## [0.0.1] - 2026-02-09

- Commands view appears above Variables.
- Commands support nested groups using / in the group name.
- Variable substitution uses ${var} to avoid email collisions.
- Commands show icon color from per-command settings or a global default.
- Inline command actions and command palette icons updated for contrast.
- Activity bar icon refreshed.
- Variables render as ${var} = value in the Variables view.