# Change Log

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