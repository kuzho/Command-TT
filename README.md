# Command TT

Send terminal commands with variables from two dedicated panels in VS Code.

## Features

- Commands panel (shown above Variables) with grouped and nested groups (use /)
- Variables panel to manage named values like ${server} or ${host}
- Run commands by clicking a command item
- Inline actions to run, edit, and remove items
- Variable substitution inside commands (ping ${host})
- Friendly error when a variable is missing
- Per-command icon and per-command iconColor, plus a global default icon color
- Optional Enter key sending controlled per command
- Refresh buttons for Commands and Variables
- All data stored in user settings JSON

## GIFs

Shows commands panel, grouping, and nested groups (use /).

![Run command](resources/gifs/demo.gif)
Run a command by clicking it and see it sent to the terminal.
Create and edit variables used in ${var} substitution.
Shows the friendly error when a variable is missing.
Refresh Commands and Variables views.

## Usage

- Open the Command TT activity bar icon.
- Add commands in the Commands panel (shown above Variables).
- Add variables in the Variables panel.
- Use / in group names to create subgroups (for example Ops/Deploy).
- Click a command to run it in the terminal.

## Extension Settings

- commandTT.commandIconColor: Theme color id for command icons (default terminal.ansiCyan).
- commandTT.variables: Array of variable definitions.
- commandTT.commands: Array of command definitions.

## Data Format

Example variables:

```
"commandTT.variables": [
  { "name": "host", "value": "8.8.8.8", "description": "DNS" }
]
```

Example commands:

```
"commandTT.commands": [
  {
    "title": "Ping",
    "command": "ping ${host}",
    "group": "Ops/Network",
    "description": "Ping current host",
    "icon": "terminal",
    "iconColor": "terminal.ansiGreen",
    "sendNewLine": true
  }
]
```
