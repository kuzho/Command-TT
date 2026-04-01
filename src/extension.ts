import * as vscode from 'vscode';

type VariableType = 'text' | 'select' | 'checkbox' | 'date';

type VariableDefinition = {
	name: string;
	value: string;
	type?: VariableType;
	description?: string;
	options?: string[];
	group?: string;
};

type CommandDefinition = {
	title: string;
	command: string;
	group?: string;
	description?: string;
	icon?: string;
	iconColor?: string;
	sendNewLine?: boolean;
};

type SortOrder = 'settings' | 'alphabetical';

type CommandGroupNode = {
	label: string;
	path: string;
	groups: CommandGroupNode[];
	commands: CommandDefinition[];
};

type VariableGroupNode = {
	label: string;
	path: string;
	groups: VariableGroupNode[];
	variables: VariableDefinition[];
};

type VariableMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'toggleGroup'; path: string; expanded: boolean }
	| { type: 'addVariable'; groupPath?: string }
	| { type: 'addFolder'; parentPath?: string }
	| { type: 'renameFolder'; path: string }
	| { type: 'deleteFolder'; path: string }
	| { type: 'saveVariable'; originalName: string; name: string; value: string }
	| { type: 'deleteVariable'; name: string }
	| { type: 'advancedEditVariable'; name: string };

const CONFIG_SECTION = 'commandTT';
const DEFAULT_GROUP = 'Ungrouped';
const VARIABLES_VIEW_ID = 'commandTTVariables';
const COMMANDS_VIEW_ID = 'commandTTCommands';

class CommandGroupItem extends vscode.TreeItem {
	public readonly path: string;

	constructor(label: string, path: string, state: vscode.TreeItemCollapsibleState) {
		super(label, state);
		this.path = path;
		this.id = path;
		this.contextValue = 'commandGroup';
		this.iconPath = new vscode.ThemeIcon('folder');
	}
}

class CommandItem extends vscode.TreeItem {
	public readonly definition: CommandDefinition;

	constructor(definition: CommandDefinition) {
		super(definition.title, vscode.TreeItemCollapsibleState.None);
		this.definition = definition;
		this.id = definition.title;
		this.description = definition.command;
		this.tooltip = definition.description || definition.command;
		this.contextValue = 'commandItem';
		this.iconPath = new vscode.ThemeIcon(definition.icon || 'rocket', getCommandIconColor(definition.iconColor));
		this.command = {
			command: 'commandTT.runCommand',
			title: 'Run Command',
			arguments: [definition]
		};
	}
}

class CommandsProvider implements vscode.TreeDataProvider<CommandGroupItem | CommandItem> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<CommandGroupItem | CommandItem | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	constructor(private readonly expandedGroups: Set<string>) {}

	refresh(): void {
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: CommandGroupItem | CommandItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: CommandGroupItem): Array<CommandGroupItem | CommandItem> {
		const commands = getCommands();
		const tree = buildCommandTree(commands, shouldSortAlphabetically());

		if (!element) {
			return tree.groups.map((group) =>
				new CommandGroupItem(
					group.label,
					group.path,
					getGroupState(group.path, this.expandedGroups)
				)
			);
		}

		const node = findGroupNode(tree, element.path);
		if (!node) {
			return [];
		}

		const children: Array<CommandGroupItem | CommandItem> = [];
		for (const group of node.groups) {
			children.push(
				new CommandGroupItem(group.label, group.path, getGroupState(group.path, this.expandedGroups))
			);
		}
		for (const command of node.commands) {
			children.push(new CommandItem(command));
		}

		return children;
	}
}

class VariablesWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private pendingFocusName?: string;

	constructor(
		private readonly expandedGroups: Set<string>,
		private readonly persistExpandedGroups: () => void
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message: VariableMessage) => {
			void this.handleMessage(message);
		});

		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.postState();
			}
		});
	}

	refresh(): void {
		this.postState();
	}

	async createVariable(groupPath?: string): Promise<void> {
		const variables = getVariables();
		const variable: VariableDefinition = {
			name: getUniqueVariableName(variables),
			value: '',
			type: 'text',
			group: normalizeGroupPath(groupPath)
		};

		await updateConfig('variables', [...variables, variable]);
		if (variable.group) {
			this.expandedGroups.add(variable.group);
			this.persistExpandedGroups();
		}
		this.pendingFocusName = variable.name;
		this.postState();
	}

	async createFolder(parentPath?: string): Promise<void> {
		const folderName = await promptForFolderName(parentPath);
		if (!folderName) {
			return;
		}

		const normalizedParent = normalizeGroupPath(parentPath);
		const newPath = normalizedParent ? `${normalizedParent}/${folderName}` : folderName;
		const folders = getVariableFolders();
		if (folders.includes(newPath)) {
			await vscode.window.showInformationMessage(`Folder already exists: ${newPath}`);
			return;
		}

		const nextFolders = shouldSortAlphabetically() ? [...folders, newPath].sort() : [...folders, newPath];
		await updateConfig('variableFolders', nextFolders);
		this.expandedGroups.add(newPath);
		if (normalizedParent) {
			this.expandedGroups.add(normalizedParent);
		}
		this.persistExpandedGroups();
		this.postState();
	}

	async renameFolder(path: string): Promise<void> {
		const parts = splitGroupPath(path);
		const currentName = parts[parts.length - 1];
		const parentPath = parts.slice(0, -1).join('/') || undefined;

		const newName = await vscode.window.showInputBox({
			prompt: `Rename folder "${currentName}"`,
			value: currentName,
			validateInput: (value) => {
				const trimmed = value.trim();
				if (!trimmed) { return 'Folder name is required.'; }
				if (trimmed.includes('/')) { return 'Use only the folder name, not a path.'; }
				return undefined;
			}
		});
		if (!newName || newName.trim() === currentName) {
			return;
		}

		const trimmedName = newName.trim();
		const newPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
		const isDefaultGroup = path === DEFAULT_GROUP;

		const folders = getVariableFolders().map((folder) => {
			if (isDefaultGroup) {
				return folder;
			}
			if (folder === path) { return newPath; }
			if (folder.startsWith(path + '/')) { return newPath + folder.slice(path.length); }
			return folder;
		});
		if (isDefaultGroup && !folders.includes(newPath)) {
			folders.push(newPath);
		}

		const variables = getVariables().map((variable) => {
			const g = normalizeGroupPath(variable.group);
			if (isDefaultGroup && !g) { return { ...variable, group: newPath }; }
			if (!g) { return variable; }
			if (g === path) { return { ...variable, group: newPath }; }
			if (g.startsWith(path + '/')) { return { ...variable, group: newPath + g.slice(path.length) }; }
			return variable;
		});

		const nextExpanded = new Set<string>();
		for (const g of this.expandedGroups) {
			if (g === path) { nextExpanded.add(newPath); }
			else if (g.startsWith(path + '/')) { nextExpanded.add(newPath + g.slice(path.length)); }
			else { nextExpanded.add(g); }
		}
		this.expandedGroups.clear();
		for (const g of nextExpanded) { this.expandedGroups.add(g); }
		this.persistExpandedGroups();

		await updateConfig('variableFolders', folders);
		await updateConfig('variables', variables);
	}

	async deleteFolder(path: string): Promise<void> {
		const label = path.split('/').pop() ?? path;
		const choice = await vscode.window.showWarningMessage(
			`Delete folder "${label}"? Variables inside will be moved to Ungrouped.`,
			{ modal: true },
			'Delete'
		);
		if (choice !== 'Delete') {
			return;
		}

		const folders = getVariableFolders().filter(
			(folder) => folder !== path && !folder.startsWith(path + '/')
		);

		const variables = getVariables().map((variable) => {
			const g = normalizeGroupPath(variable.group);
			if (!g) { return variable; }
			if (g === path || g.startsWith(path + '/')) {
				return { ...variable, group: undefined };
			}
			return variable;
		});

		for (const g of Array.from(this.expandedGroups)) {
			if (g === path || g.startsWith(path + '/')) {
				this.expandedGroups.delete(g);
			}
		}
		this.persistExpandedGroups();

		await updateConfig('variableFolders', folders);
		await updateConfig('variables', variables);
	}

	async editVariable(name?: string): Promise<void> {
		const selected = name
			? getVariables().find((variable) => variable.name === name)
			: await pickVariable();
		if (!selected) {
			return;
		}

		const updated = await promptForVariable(selected, selected.group);
		if (!updated) {
			return;
		}

		const duplicate = getVariables().find(
			(variable) => variable.name === updated.name && variable.name !== selected.name
		);
		if (duplicate) {
			await vscode.window.showErrorMessage(`A variable named ${updated.name} already exists.`);
			return;
		}

		const variables = getVariables().map((variable) => (variable.name === selected.name ? updated : variable));
		await updateConfig('variables', variables);
		if (updated.group) {
			this.expandedGroups.add(updated.group);
			this.persistExpandedGroups();
		}
		this.pendingFocusName = updated.name;
		this.postState();
	}

	async removeVariable(name?: string): Promise<void> {
		const selected = name
			? getVariables().find((variable) => variable.name === name)
			: await pickVariable();
		if (!selected) {
			return;
		}

		const updated = getVariables().filter((variable) => variable.name !== selected.name);
		await updateConfig('variables', updated);
		this.postState();
	}

	private async handleMessage(message: VariableMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
			case 'refresh':
				this.postState();
				return;
			case 'toggleGroup':
				if (message.expanded) {
					this.expandedGroups.add(message.path);
				} else {
					this.expandedGroups.delete(message.path);
				}
				this.persistExpandedGroups();
				this.postState();
				return;
			case 'addVariable':
				await this.createVariable(message.groupPath);
				return;
			case 'addFolder':
				await this.createFolder(message.parentPath);
				return;
			case 'renameFolder':
				await this.renameFolder(message.path);
				return;
			case 'deleteFolder':
				await this.deleteFolder(message.path);
				return;
			case 'deleteVariable':
				await this.removeVariable(message.name);
				return;
			case 'advancedEditVariable':
				await this.editVariable(message.name);
				return;
			case 'saveVariable':
				await this.saveVariable(message);
				return;
		}
	}

	private async saveVariable(message: Extract<VariableMessage, { type: 'saveVariable' }>): Promise<void> {
		const variables = getVariables();
		const selected = variables.find((variable) => variable.name === message.originalName);
		if (!selected) {
			this.postState();
			return;
		}

		const nextName = message.name.trim();
		if (!nextName) {
			await vscode.window.showErrorMessage('Variable name is required.');
			this.pendingFocusName = selected.name;
			this.postState();
			return;
		}

		if (!/^[A-Za-z0-9_-]+$/.test(nextName)) {
			await vscode.window.showErrorMessage('Use only letters, numbers, underscore, or hyphen in variable names.');
			this.pendingFocusName = selected.name;
			this.postState();
			return;
		}

		const duplicate = variables.find(
			(variable) => variable.name === nextName && variable.name !== message.originalName
		);
		if (duplicate) {
			await vscode.window.showErrorMessage(`A variable named ${nextName} already exists.`);
			this.pendingFocusName = selected.name;
			this.postState();
			return;
		}

		const updated: VariableDefinition = {
			name: nextName,
			value: normalizeVariableValue(selected.type ?? 'text', message.value, selected.options),
			group: selected.group,
			type: selected.type,
			options: selected.options
		};

		const nameChanged = updated.name !== selected.name;
		const valueChanged = updated.value !== selected.value;
		if (!nameChanged && !valueChanged) {
			return;
		}

		const nextVariables = variables.map((variable) =>
			variable.name === message.originalName ? updated : variable
		);
		await updateConfig('variables', nextVariables);
		if (nameChanged) {
			this.pendingFocusName = updated.name;
			this.postState();
		}
	}

	private postState(): void {
		if (!this.view) {
			return;
		}

		void this.view.webview.postMessage({
			type: 'state',
			payload: {
				tree: buildVariableTree(getVariables(), getVariableFolders(), shouldSortAlphabetically()),
				expandedGroups: Array.from(this.expandedGroups),
				focusName: this.pendingFocusName
			}
		});
		this.pendingFocusName = undefined;
	}

	private getHtml(_webview: vscode.Webview): string {
		const nonce = createNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Variables</title>
	<style>
		:root { color-scheme: light dark; }
		body {
			margin: 0;
			padding: 4px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
		}
		button, input, select { font: inherit; }
		#app { display: grid; gap: 4px; }
		.icon-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 26px;
			height: 26px;
			padding: 0;
			border: 1px solid transparent;
			border-radius: 6px;
			background: transparent;
			color: var(--vscode-icon-foreground);
			cursor: pointer;
		}
		.icon-button:hover {
			background: var(--vscode-toolbar-hoverBackground);
			border-color: var(--vscode-toolbar-hoverOutline, transparent);
		}
		.icon-button svg {
			width: 16px;
			height: 16px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.8;
			stroke-linecap: round;
			stroke-linejoin: round;
		}
		.group { display: grid; gap: 6px; }
		.group-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 3px 2px 3px calc(var(--depth, 0) * 12px);
			border-radius: 8px;
			background: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 70%, transparent);
			cursor: pointer;
		}
		.group-label {
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.spacer { flex: 1; }
		.group-body { display: grid; gap: 6px; }
		.group-body[hidden] { display: none !important; }
		.variable-row {
			display: grid;
			grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr) auto auto auto;
			align-items: center;
			gap: 6px;
			padding: 3px 2px 3px calc(var(--depth, 0) * 12px + 18px);
			border-radius: 8px;
		}
		.variable-row:hover {
			background: color-mix(in srgb, var(--vscode-list-hoverBackground) 40%, transparent);
		}
		.variable-label {
			min-width: 0;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.variable-meta {
			display: flex;
			align-items: center;
			gap: 6px;
			min-width: 0;
		}
		.variable-type {
			padding: 2px 6px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--vscode-badge-background) 70%, transparent);
			color: var(--vscode-badge-foreground);
			font-size: 11px;
			text-transform: lowercase;
		}
		.variable-control-wrap {
			min-width: 0;
		}
		.variable-input,
		.variable-select {
			width: 100%;
			min-width: 0;
			padding: 5px 8px;
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 6px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
		}
		.variable-input[type='date'] {
			color-scheme: light dark;
		}
		.variable-input:focus,
		.variable-select:focus {
			outline: 1px solid var(--vscode-focusBorder);
			border-color: var(--vscode-focusBorder);
		}
		.variable-checkbox {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 0 4px;
			min-height: 30px;
		}
		.variable-checkbox input {
			margin: 0;
		}
		.variable-checkbox-label {
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.variable-spacer {
			width: 1px;
			height: 1px;
		}
		.empty-state {
			padding: 14px;
			border: 1px dashed var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
			border-radius: 10px;
			color: var(--vscode-descriptionForeground);
			text-align: center;
		}
	</style>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const app = document.getElementById('app');
		const state = { tree: undefined, expandedGroups: new Set(), focusName: undefined };
		const icons = {
			add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
			folderPlus: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M16 11v6M13 14h6"/></svg>',
			edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4.5-1 9.25-9.25a1.5 1.5 0 0 0 0-2.12l-1.38-1.38a1.5 1.5 0 0 0-2.12 0L5 15.5 4 20z"/><path d="M13.5 6.5l4 4"/></svg>',
			delete: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/></svg>',
			refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 1-2.34-5.66"/><path d="M20 4v7h-7"/></svg>',
			folder: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
			chevronRight: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
			chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
		};

		function button(action, title, icon, dataset = {}) {
			const element = document.createElement('button');
			element.type = 'button';
			element.className = 'icon-button';
			element.dataset.action = action;
			element.title = title;
			element.setAttribute('aria-label', title);
			for (const [key, value] of Object.entries(dataset)) {
				if (value !== undefined) {
					element.dataset[key] = value;
				}
			}
			element.innerHTML = icon;
			return element;
		}

		function createInput(className, value, originalName, placeholder) {
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'variable-input ' + className;
			input.value = value || '';
			input.placeholder = placeholder;
			input.dataset.originalName = originalName;
			return input;
		}

		function createSelect(className, originalName, options, value) {
			const select = document.createElement('select');
			select.className = 'variable-select ' + className;
			select.dataset.originalName = originalName;
			for (const optionValue of options || []) {
				const option = document.createElement('option');
				option.value = optionValue;
				option.textContent = optionValue;
				select.append(option);
			}
			select.value = value || '';
			if (!select.value && select.options.length > 0) {
				select.value = select.options[0].value;
			}
			return select;
		}

		function postValue(originalName, value) {
			vscode.postMessage({
				type: 'saveVariable',
				originalName,
				name: originalName,
				value
			});
		}

		function createControl(variable) {
			const type = variable.type || 'text';
			if (type === 'select') {
				const select = createSelect('variable-value', variable.name, variable.options || [], variable.value);
				select.title = variable.value || '';
				return select;
			}
			if (type === 'checkbox') {
				const wrap = document.createElement('label');
				wrap.className = 'variable-checkbox';
				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.className = 'variable-checkbox-input';
				checkbox.dataset.originalName = variable.name;
				const options = Array.isArray(variable.options) ? variable.options : [];
				checkbox.dataset.offValue = options[0] || 'false';
				checkbox.dataset.onValue = options[1] || 'true';
				checkbox.checked = variable.value === checkbox.dataset.onValue;
				const label = document.createElement('span');
				label.className = 'variable-checkbox-label';
				label.textContent = checkbox.checked ? checkbox.dataset.onValue : checkbox.dataset.offValue;
				wrap.append(checkbox, label);
				return wrap;
			}
			const input = createInput('variable-value', variable.value, variable.name, type === 'date' ? 'YYYY-MM-DD' : 'value');
			input.type = type === 'date' ? 'date' : 'text';
			input.title = variable.value || '';
			return input;
		}

		function renderVariable(variable, depth) {
			const row = document.createElement('div');
			row.className = 'variable-row';
			row.style.setProperty('--depth', String(depth));

			const label = document.createElement('div');
			label.className = 'variable-label';
			label.textContent = '$' + '{' + (variable.name || '') + '}';
			label.title = '$' + '{' + (variable.name || '') + '}';

			const controlWrap = document.createElement('div');
			controlWrap.className = 'variable-control-wrap';
			controlWrap.append(createControl(variable));

			const meta = document.createElement('div');
			meta.className = 'variable-meta';
			const typeBadge = document.createElement('span');
			typeBadge.className = 'variable-type';
			typeBadge.textContent = variable.type || 'text';
			meta.append(typeBadge);

			row.append(
				label,
				controlWrap,
				meta,
				button('advanced-edit-variable', 'Edit variable', icons.edit, { name: variable.name }),
				button('delete-variable', 'Remove variable', icons.delete, { name: variable.name })
			);

			row.title = (variable.name || '') + ' = ' + (variable.value || '');

			return row;
		}

		function renderGroup(node, depth) {
			const section = document.createElement('section');
			section.className = 'group';

			const header = document.createElement('div');
			header.className = 'group-header';
			header.style.setProperty('--depth', String(depth));
			header.dataset.path = node.path;

			const expanded = state.expandedGroups.has(node.path);
			header.append(button('toggle-group', expanded ? 'Collapse folder' : 'Expand folder', expanded ? icons.chevronDown : icons.chevronRight, {
				path: node.path,
				expanded: String(!expanded)
			}));

			const folderIcon = document.createElement('span');
			folderIcon.className = 'icon-button';
			folderIcon.innerHTML = icons.folder;
			folderIcon.setAttribute('aria-hidden', 'true');
			header.append(folderIcon);

			const label = document.createElement('span');
			label.className = 'group-label';
			label.textContent = node.label;
			header.append(label);

			const spacer = document.createElement('div');
			spacer.className = 'spacer';
			header.append(spacer);

			header.append(
				button('add-variable', 'Add variable', icons.add, { path: node.path }),
				button('add-folder', 'Add subfolder', icons.folderPlus, { path: node.path }),
				button('rename-folder', 'Rename folder', icons.edit, { path: node.path }),
				button('delete-folder', 'Delete folder', icons.delete, { path: node.path })
			);

			const body = document.createElement('div');
			body.className = 'group-body';
			body.hidden = !expanded;

			for (const group of node.groups || []) {
				body.append(renderGroup(group, depth + 1));
			}

			for (const variable of node.variables || []) {
				body.append(renderVariable(variable, depth + 1));
			}

			section.append(header, body);
			return section;
		}

		function render() {
			app.replaceChildren();
			if (!state.tree || !Array.isArray(state.tree.groups) || state.tree.groups.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'empty-state';
				empty.textContent = 'No variables yet. Use the add buttons to create variables or folders.';
				app.append(empty);
				return;
			}
			for (const group of state.tree.groups) {
				app.append(renderGroup(group, 0));
			}
		}

		app.addEventListener('click', (event) => {
			const origin = event.target instanceof Element ? event.target : undefined;
			if (!origin) {
				return;
			}

			const target = origin.closest('button[data-action]');
			if (target) {
				switch (target.dataset.action) {
				case 'refresh':
					vscode.postMessage({ type: 'refresh' });
					return;
				case 'toggle-group':
					vscode.postMessage({
						type: 'toggleGroup',
						path: target.dataset.path || '',
						expanded: target.dataset.expanded === 'true'
					});
					return;
				case 'add-variable':
					vscode.postMessage({ type: 'addVariable', groupPath: target.dataset.path || '' });
					return;
				case 'add-folder':
					vscode.postMessage({ type: 'addFolder', parentPath: target.dataset.path || '' });
					return;
				case 'rename-folder':
					vscode.postMessage({ type: 'renameFolder', path: target.dataset.path || '' });
					return;
				case 'delete-folder':
					vscode.postMessage({ type: 'deleteFolder', path: target.dataset.path || '' });
					return;
				case 'delete-variable':
					vscode.postMessage({ type: 'deleteVariable', name: target.dataset.name });
					return;
				case 'advanced-edit-variable':
					vscode.postMessage({ type: 'advancedEditVariable', name: target.dataset.name });
					return;
				}
			}

			const header = origin.closest('.group-header');
			if (header instanceof HTMLElement && header.dataset.path) {
				const path = header.dataset.path;
				const expanded = state.expandedGroups.has(path);
				vscode.postMessage({
					type: 'toggleGroup',
					path,
					expanded: !expanded
				});
				return;
			}
		});

		app.addEventListener('blur', (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) {
				return;
			}
			if (!target.classList.contains('variable-value') || target.type !== 'text') {
				return;
			}
			postValue(target.dataset.originalName, target.value);
		}, true);

		app.addEventListener('input', (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) {
				return;
			}
			if (!target.classList.contains('variable-value') || target.type !== 'text') {
				return;
			}
			postValue(target.dataset.originalName, target.value);
		});

		app.addEventListener('change', (event) => {
			const target = event.target;
			if (target instanceof HTMLSelectElement && target.classList.contains('variable-value')) {
				postValue(target.dataset.originalName, target.value);
				return;
			}
			if (target instanceof HTMLInputElement && target.classList.contains('variable-value') && target.type === 'date') {
				postValue(target.dataset.originalName, target.value);
				return;
			}
			if (target instanceof HTMLInputElement && target.classList.contains('variable-checkbox-input')) {
				const label = target.parentElement?.querySelector('.variable-checkbox-label');
				const nextValue = target.checked ? target.dataset.onValue : target.dataset.offValue;
				if (label instanceof HTMLElement) {
					label.textContent = nextValue || '';
				}
				postValue(target.dataset.originalName, nextValue || '');
			}
		});

		app.addEventListener('keydown', (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				postValue(target.dataset.originalName, target.value);
				target.blur();
			}
		});

		window.addEventListener('message', (event) => {
			if (!event.data || event.data.type !== 'state') {
				return;
			}
			state.tree = event.data.payload.tree;
			state.expandedGroups = new Set(event.data.payload.expandedGroups || []);
			state.focusName = event.data.payload.focusName;
			render();
			if (state.focusName) {
				const input = app.querySelector('[data-original-name="' + CSS.escape(state.focusName) + '"]');
				if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
					input.focus();
					if (input instanceof HTMLInputElement && input.type === 'text') {
						input.select();
					}
				}
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function getGroupState(path: string, expandedGroups: Set<string>): vscode.TreeItemCollapsibleState {
	return expandedGroups.has(path)
		? vscode.TreeItemCollapsibleState.Expanded
		: vscode.TreeItemCollapsibleState.Collapsed;
}

function getSortOrder(): SortOrder {
	return getConfig().get<SortOrder>('sortOrder', 'settings');
}

function shouldSortAlphabetically(): boolean {
	return getSortOrder() === 'alphabetical';
}

function getCommandIconColor(override?: string): vscode.ThemeColor | undefined {
	const colorId = override?.trim() || getConfig().get<string>('commandIconColor', '').trim();
	return colorId ? new vscode.ThemeColor(colorId) : undefined;
}

function getVariables(): VariableDefinition[] {
	return getConfig().get<VariableDefinition[]>('variables', []).map(normalizeVariable);
}

function getVariableFolders(): string[] {
	const folders = getConfig().get<string[]>('variableFolders', []);
	const normalized = folders
		.map((folder) => normalizeGroupPath(folder))
		.filter((folder): folder is string => Boolean(folder));
	return Array.from(new Set(normalized));
}

function getCommands(): CommandDefinition[] {
	return getConfig().get<CommandDefinition[]>('commands', []);
}

async function updateConfig<T>(key: string, value: T): Promise<void> {
	await getConfig().update(key, value, vscode.ConfigurationTarget.Global);
}

function splitGroupPath(raw?: string): string[] {
	return (raw || '')
		.split('/')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function normalizeGroupPath(raw?: string): string | undefined {
	const parts = splitGroupPath(raw);
	return parts.length > 0 ? parts.join('/') : undefined;
}

function getUniqueVariableName(variables: VariableDefinition[], baseName = 'name'): string {
	const used = new Set(variables.map((variable) => variable.name));
	if (!used.has(baseName)) {
		return baseName;
	}
	let index = 2;
	while (used.has(`${baseName}${index}`)) {
		index += 1;
	}
	return `${baseName}${index}`;
}

function isVariableType(value: string | undefined): value is VariableType {
	return value === 'text' || value === 'select' || value === 'checkbox' || value === 'date';
}

function normalizeVariableOptions(type: VariableType, options?: string[], value?: string): string[] | undefined {
	const normalizedOptions = (options ?? [])
		.map((option) => option.trim())
		.filter((option) => option.length > 0);
	if (type === 'checkbox') {
		const checkboxOptions = normalizedOptions.slice(0, 2);
		while (checkboxOptions.length < 2) {
			checkboxOptions.push(checkboxOptions.length === 0 ? 'No' : 'Yes');
		}
		return checkboxOptions;
	}
	if (type === 'select') {
		if (normalizedOptions.length > 0) {
			return normalizedOptions;
		}
		return value?.trim() ? [value.trim()] : ['Option 1'];
	}
	return normalizedOptions.length > 0 ? normalizedOptions : undefined;
}

function normalizeDateValue(value?: string): string {
	const trimmed = value?.trim() ?? '';
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return trimmed;
	}
	return new Date().toISOString().slice(0, 10);
}

function normalizeVariableValue(type: VariableType, value?: string, options?: string[]): string {
	const trimmed = value ?? '';
	if (type === 'select') {
		return options && options.length > 0
			? (options.includes(trimmed) ? trimmed : options[0])
			: trimmed;
	}
	if (type === 'checkbox') {
		const checkboxOptions = normalizeVariableOptions(type, options, trimmed) ?? ['No', 'Yes'];
		return trimmed === checkboxOptions[1] ? checkboxOptions[1] : checkboxOptions[0];
	}
	if (type === 'date') {
		return normalizeDateValue(trimmed);
	}
	return trimmed;
}

function normalizeVariable(variable: VariableDefinition): VariableDefinition {
	const type = isVariableType(variable.type)
		? variable.type
		: Array.isArray(variable.options) && variable.options.length > 0
			? 'select'
			: 'text';
	const options = normalizeVariableOptions(type, variable.options, variable.value);
	return {
		...variable,
		name: variable.name.trim(),
		group: normalizeGroupPath(variable.group),
		type,
		options,
		value: normalizeVariableValue(type, variable.value, options)
	};
}

function ensureVariableGroup(root: VariableGroupNode, pathParts: string[]): VariableGroupNode {
	let current = root;
	let currentPath = '';
	for (const part of pathParts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		let child = current.groups.find((node) => node.label === part);
		if (!child) {
			child = { label: part, path: currentPath, groups: [], variables: [] };
			current.groups.push(child);
		}
		current = child;
	}
	return current;
}

function buildCommandTree(commands: CommandDefinition[], sortAlphabetically: boolean): CommandGroupNode {
	const root: CommandGroupNode = { label: '', path: '', groups: [], commands: [] };
	for (const command of commands) {
		const groupParts = splitGroupPath(command.group);
		const parts = groupParts.length > 0 ? groupParts : [DEFAULT_GROUP];
		let current = root;
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			let child = current.groups.find((node) => node.label === part);
			if (!child) {
				child = { label: part, path: currentPath, groups: [], commands: [] };
				current.groups.push(child);
			}
			current = child;
		}
		current.commands.push(command);
	}
	if (sortAlphabetically) {
		const sortNode = (node: CommandGroupNode): void => {
			node.groups.sort((a, b) => a.label.localeCompare(b.label));
			node.commands.sort((a, b) => a.title.localeCompare(b.title));
			for (const child of node.groups) {
				sortNode(child);
			}
		};
		for (const child of root.groups) {
			sortNode(child);
		}
	}
	return root;
}

function buildVariableTree(
	variables: VariableDefinition[],
	folders: string[],
	sortAlphabetically: boolean
): VariableGroupNode {
	const root: VariableGroupNode = { label: '', path: '', groups: [], variables: [] };
	for (const folder of folders) {
		ensureVariableGroup(root, splitGroupPath(folder));
	}
	for (const variable of variables) {
		const groupParts = splitGroupPath(variable.group);
		const parts = groupParts.length > 0 ? groupParts : [DEFAULT_GROUP];
		ensureVariableGroup(root, parts).variables.push(variable);
	}
	if (sortAlphabetically) {
		const sortNode = (node: VariableGroupNode): void => {
			node.groups.sort((a, b) => a.label.localeCompare(b.label));
			node.variables.sort((a, b) => a.name.localeCompare(b.name));
			for (const child of node.groups) {
				sortNode(child);
			}
		};
		for (const child of root.groups) {
			sortNode(child);
		}
	}
	return root;
}

function findGroupNode(root: CommandGroupNode, path: string): CommandGroupNode | undefined {
	if (!path) {
		return root;
	}
	const parts = path.split('/');
	let current: CommandGroupNode | undefined = root;
	for (const part of parts) {
		current = current?.groups.find((node) => node.label === part);
		if (!current) {
			return undefined;
		}
	}
	return current;
}

function getVariableByName(name: string, variables: VariableDefinition[]): VariableDefinition | undefined {
	return variables.find((variable) => variable.name === name);
}

async function substituteVariables(text: string, variables: VariableDefinition[]): Promise<{ result: string; missing: string[] }> {
	const missing = new Set<string>();
	const variablesToReplace = new Map<string, string>();
	const matches = Array.from(text.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g));
	for (const match of matches) {
		const name = match[1];
		if (variablesToReplace.has(name)) {
			continue;
		}
		const variable = getVariableByName(name, variables);
		if (!variable) {
			missing.add(name);
			continue;
		}
		const value = variable.value;
		if (value === undefined) {
			missing.add(name);
		} else {
			variablesToReplace.set(name, value);
		}
	}
	let result = text;
	for (const [name, value] of variablesToReplace) {
		result = result.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value);
	}
	return { result, missing: Array.from(missing) };
}

function getActiveTerminal(): vscode.Terminal | undefined {
	return vscode.window.activeTerminal;
}

async function runCommand(definition: CommandDefinition): Promise<void> {
	const variables = getVariables();
	const { result, missing } = await substituteVariables(definition.command, variables);
	if (missing.length > 0) {
		await vscode.window.showErrorMessage(`Missing variables: ${missing.map((name) => `\${${name}}`).join(', ')}`);
		return;
	}
	const terminal = getActiveTerminal();
	if (!terminal) {
		await vscode.window.showErrorMessage('No active terminal found.');
		return;
	}
	terminal.show();
	terminal.sendText(result, definition.sendNewLine ?? true);
}

async function promptForVariable(existing?: VariableDefinition, defaultGroup?: string): Promise<VariableDefinition | undefined> {
	const name = await vscode.window.showInputBox({
		prompt: 'Variable name (used as ${name})',
		value: existing?.name,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Variable name is required.';
			}
			if (!/^[A-Za-z0-9_-]+$/.test(value.trim())) {
				return 'Use only letters, numbers, underscore, or hyphen.';
			}
			return undefined;
		}
	});
	if (!name) {
		return undefined;
	}
	const group = await vscode.window.showInputBox({
		prompt: 'Group (optional, use / for subgroups)',
		value: existing?.group ?? defaultGroup
	});
	if (group === undefined) {
		return undefined;
	}
	const typePick = await vscode.window.showQuickPick([
		{ label: 'Text', value: 'text' },
		{ label: 'Select', value: 'select' },
		{ label: 'Checkbox', value: 'checkbox' },
		{ label: 'Date', value: 'date' }
	], {
		placeHolder: 'Choose the variable type',
		title: 'Variable Type'
	});
	if (!typePick) {
		return undefined;
	}
	const type = typePick.value as VariableType;
	let value = existing?.value ?? '';
	let options: string[] | undefined;
	if (type === 'text') {
		const textValue = await vscode.window.showInputBox({
			prompt: 'Variable value',
			value: existing?.type === 'text' ? existing.value : ''
		});
		if (textValue === undefined) {
			return undefined;
		}
		value = textValue;
	}
	if (type === 'select' || type === 'checkbox') {
		const optionText = await vscode.window.showInputBox({
			prompt: type === 'checkbox'
				? 'Two options separated by comma (example: Disabled, Enabled)'
				: 'Options separated by comma',
			value: existing?.options?.join(', ') ?? '',
			validateInput: (raw) => {
				const parsed = raw.split(',').map((option) => option.trim()).filter((option) => option.length > 0);
				if (type === 'checkbox' && parsed.length !== 2) {
					return 'Checkbox variables require exactly 2 options.';
				}
				if (type === 'select' && parsed.length === 0) {
					return 'Add at least one option.';
				}
				return undefined;
			}
		});
		if (optionText === undefined) {
			return undefined;
		}
		options = optionText.split(',').map((option) => option.trim()).filter((option) => option.length > 0);
		const valuePick = await vscode.window.showQuickPick(
			options.map((option) => ({ label: option })),
			{
				placeHolder: 'Choose the current value',
				title: 'Current Variable Value'
			}
		);
		if (!valuePick) {
			return undefined;
		}
		value = valuePick.label;
	}
	if (type === 'date') {
		const dateValue = await vscode.window.showInputBox({
			prompt: 'Date value in YYYY-MM-DD format',
			value: existing?.type === 'date' ? normalizeDateValue(existing.value) : normalizeDateValue(),
			validateInput: (raw) => /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? undefined : 'Use YYYY-MM-DD format.'
		});
		if (dateValue === undefined) {
			return undefined;
		}
		value = normalizeDateValue(dateValue);
	}
	return {
		name: name.trim(),
		value: normalizeVariableValue(type, value, options),
		group: normalizeGroupPath(group),
		type,
		options: options && options.length > 0 ? options : undefined
	};
}

async function promptForCommand(existing?: CommandDefinition, defaultGroup?: string): Promise<CommandDefinition | undefined> {
	const title = await vscode.window.showInputBox({
		prompt: 'Command title',
		value: existing?.title,
		validateInput: (value) => (value.trim() ? undefined : 'Title is required.')
	});
	if (!title) {
		return undefined;
	}
	const command = await vscode.window.showInputBox({
		prompt: 'Command text (use ${varName} for variables)',
		value: existing?.command
	});
	if (command === undefined || !command.trim()) {
		return undefined;
	}
	const group = await vscode.window.showInputBox({
		prompt: 'Group (optional, use / for subgroups, e.g. Ops/Deploy)',
		value: existing?.group ?? defaultGroup
	});
	if (group === undefined) {
		return undefined;
	}
	const description = await vscode.window.showInputBox({
		prompt: 'Description (optional)',
		value: existing?.description
	});
	if (description === undefined) {
		return undefined;
	}
	const icon = await vscode.window.showInputBox({
		prompt: 'Icon codicon name (optional, e.g. terminal, cloud, rocket)',
		value: existing?.icon
	});
	if (icon === undefined) {
		return undefined;
	}
	const iconColor = await vscode.window.showInputBox({
		prompt: 'Icon color id (optional, e.g. terminal.ansiGreen, foreground)',
		value: existing?.iconColor
	});
	if (iconColor === undefined) {
		return undefined;
	}
	const sendNewLineResponse = await vscode.window.showQuickPick(['Yes', 'No'], {
		placeHolder: `Send a newline (Enter) after the command? (Current: ${(existing?.sendNewLine ?? true) ? 'Yes' : 'No'})`,
		title: 'Send Newline After Command'
	});
	if (sendNewLineResponse === undefined) {
		return undefined;
	}
	return {
		title: title.trim(),
		command: command.trim(),
		group: normalizeGroupPath(group),
		description: description.trim() || undefined,
		icon: icon.trim() || undefined,
		iconColor: iconColor.trim() || undefined,
		sendNewLine: sendNewLineResponse === 'Yes'
	};
}

async function promptForFolderName(parentPath?: string): Promise<string | undefined> {
	const label = parentPath ? `New folder inside ${parentPath}` : 'New root folder';
	const folderName = await vscode.window.showInputBox({
		prompt: label,
		placeHolder: 'Folder name',
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				return 'Folder name is required.';
			}
			if (trimmed.includes('/')) {
				return 'Use nested folders by creating them inside an existing folder.';
			}
			return undefined;
		}
	});
	return folderName?.trim() || undefined;
}

function getCommandGroupPaths(commands: CommandDefinition[]): string[] {
	const groups = new Set<string>();
	for (const command of commands) {
		const parts = splitGroupPath(command.group);
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			groups.add(currentPath);
		}
	}
	return Array.from(groups);
}

async function pickCommandGroupPath(): Promise<string | undefined> {
	const groups = getCommandGroupPaths(getCommands());
	if (groups.length === 0) {
		await vscode.window.showInformationMessage('No command folders available.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		groups.map((group) => ({ label: group })),
		{ placeHolder: 'Select a command folder' }
	);
	return pick?.label;
}

async function pickVariable(): Promise<VariableDefinition | undefined> {
	const variables = getVariables();
	if (variables.length === 0) {
		await vscode.window.showInformationMessage('No variables configured yet.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		variables.map((variable) => ({
			label: variable.name,
			description: variable.value
		})),
		{ placeHolder: 'Select a variable' }
	);
	return variables.find((variable) => variable.name === pick?.label);
}

async function pickCommand(): Promise<CommandDefinition | undefined> {
	const commands = getCommands();
	if (commands.length === 0) {
		await vscode.window.showInformationMessage('No commands configured yet.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		commands.map((command) => ({
			label: command.title,
			description: command.group || DEFAULT_GROUP,
			detail: command.description || command.command
		})),
		{ placeHolder: 'Select a command' }
	);
	return commands.find((command) => command.title === pick?.label);
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 16; index += 1) {
		value += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return value;
}

export function activate(context: vscode.ExtensionContext) {
	const expandedCommandGroups = new Set<string>(context.globalState.get<string[]>('commandTT.expandedGroups', []));
	const expandedVariableGroups = new Set<string>(context.globalState.get<string[]>('commandTT.expandedVariableGroups', []));
	const persistExpandedGroups = (): void => {
		void context.globalState.update('commandTT.expandedGroups', Array.from(expandedCommandGroups));
		void context.globalState.update('commandTT.expandedVariableGroups', Array.from(expandedVariableGroups));
	};
	const commandsProvider = new CommandsProvider(expandedCommandGroups);
	const variablesProvider = new VariablesWebviewProvider(expandedVariableGroups, persistExpandedGroups);
	const commandsTreeView = vscode.window.createTreeView(COMMANDS_VIEW_ID, { treeDataProvider: commandsProvider });
	context.subscriptions.push(
		commandsTreeView,
		vscode.window.registerWebviewViewProvider(VARIABLES_VIEW_ID, variablesProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				variablesProvider.refresh();
				commandsProvider.refresh();
			}
		}),
		vscode.commands.registerCommand('commandTT.refreshVariables', () => variablesProvider.refresh()),
		vscode.commands.registerCommand('commandTT.refreshCommands', () => commandsProvider.refresh()),
		vscode.commands.registerCommand('commandTT.addVariable', async (groupPath?: string) => {
			await variablesProvider.createVariable(groupPath);
		}),
		vscode.commands.registerCommand('commandTT.addFolder', async (parentPath?: string) => {
			await variablesProvider.createFolder(parentPath);
		}),
		vscode.commands.registerCommand('commandTT.editVariable', async (name?: string) => {
			await variablesProvider.editVariable(typeof name === 'string' ? name : undefined);
		}),
		vscode.commands.registerCommand('commandTT.removeVariable', async (name?: string) => {
			await variablesProvider.removeVariable(typeof name === 'string' ? name : undefined);
		}),
		vscode.commands.registerCommand('commandTT.addCommand', async (target?: CommandGroupItem | string) => {
			const defaultGroup = typeof target === 'string'
				? normalizeGroupPath(target)
				: target instanceof CommandGroupItem
					? normalizeGroupPath(target.path)
					: undefined;
			const command = await promptForCommand(undefined, defaultGroup);
			if (!command) {
				return;
			}
			const commands = getCommands();
			const existingIndex = commands.findIndex((item) => item.title === command.title);
			if (existingIndex >= 0) {
				commands[existingIndex] = command;
			} else {
				commands.push(command);
			}
			await updateConfig('commands', commands);
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.addCommandGroup', async (target?: CommandGroupItem | string) => {
			const parentPath = typeof target === 'string'
				? normalizeGroupPath(target)
				: target instanceof CommandGroupItem
					? normalizeGroupPath(target.path)
					: undefined;
			const folderName = await promptForFolderName(parentPath);
			if (!folderName) {
				return;
			}
			const groupPath = parentPath ? `${parentPath}/${folderName}` : folderName;
			const command = await promptForCommand(undefined, groupPath);
			if (!command) {
				return;
			}
			const commands = getCommands();
			const existingIndex = commands.findIndex((item) => item.title === command.title);
			if (existingIndex >= 0) {
				commands[existingIndex] = command;
			} else {
				commands.push(command);
			}
			await updateConfig('commands', commands);
			expandedCommandGroups.add(groupPath);
			persistExpandedGroups();
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.renameCommandGroup', async (target?: CommandGroupItem | string) => {
			const path = typeof target === 'string'
				? normalizeGroupPath(target)
				: target instanceof CommandGroupItem
					? normalizeGroupPath(target.path)
					: await pickCommandGroupPath();
			if (!path) {
				return;
			}

			const parts = splitGroupPath(path);
			const currentName = parts[parts.length - 1];
			const parentPath = parts.slice(0, -1).join('/') || undefined;
			const newName = await vscode.window.showInputBox({
				prompt: `Rename folder "${currentName}"`,
				value: currentName,
				validateInput: (value) => {
					const trimmed = value.trim();
					if (!trimmed) { return 'Folder name is required.'; }
					if (trimmed.includes('/')) { return 'Use only the folder name, not a path.'; }
					return undefined;
				}
			});
			if (!newName || newName.trim() === currentName) {
				return;
			}

			const trimmed = newName.trim();
			const newPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;
			const isDefaultGroup = path === DEFAULT_GROUP;
			const commands = getCommands().map((command) => {
				const group = normalizeGroupPath(command.group);
				if (isDefaultGroup && !group) { return { ...command, group: newPath }; }
				if (!group) { return command; }
				if (group === path) { return { ...command, group: newPath }; }
				if (group.startsWith(path + '/')) { return { ...command, group: newPath + group.slice(path.length) }; }
				return command;
			});

			const nextExpanded = new Set<string>();
			for (const group of expandedCommandGroups) {
				if (group === path) { nextExpanded.add(newPath); }
				else if (group.startsWith(path + '/')) { nextExpanded.add(newPath + group.slice(path.length)); }
				else { nextExpanded.add(group); }
			}
			expandedCommandGroups.clear();
			for (const group of nextExpanded) { expandedCommandGroups.add(group); }
			persistExpandedGroups();

			await updateConfig('commands', commands);
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.deleteCommandGroup', async (target?: CommandGroupItem | string) => {
			const path = typeof target === 'string'
				? normalizeGroupPath(target)
				: target instanceof CommandGroupItem
					? normalizeGroupPath(target.path)
					: await pickCommandGroupPath();
			if (!path) {
				return;
			}
			const label = path.split('/').pop() ?? path;
			const choice = await vscode.window.showWarningMessage(
				`Delete folder "${label}"? Commands inside will be moved to Ungrouped.`,
				{ modal: true },
				'Delete'
			);
			if (choice !== 'Delete') {
				return;
			}

			const commands = getCommands().map((command) => {
				const group = normalizeGroupPath(command.group);
				if (!group) { return command; }
				if (group === path || group.startsWith(path + '/')) {
					return { ...command, group: undefined };
				}
				return command;
			});

			for (const group of Array.from(expandedCommandGroups)) {
				if (group === path || group.startsWith(path + '/')) {
					expandedCommandGroups.delete(group);
				}
			}
			persistExpandedGroups();

			await updateConfig('commands', commands);
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.editCommand', async (item?: CommandItem) => {
			const selected = item?.definition ?? (await pickCommand());
			if (!selected) {
				return;
			}
			const updated = await promptForCommand(selected);
			if (!updated) {
				return;
			}
			const commands = getCommands().filter((command) => command.title !== selected.title);
			commands.push(updated);
			await updateConfig('commands', commands);
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.removeCommand', async (item?: CommandItem) => {
			const selected = item?.definition ?? (await pickCommand());
			if (!selected) {
				return;
			}
			const commands = getCommands().filter((command) => command.title !== selected.title);
			await updateConfig('commands', commands);
			commandsProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.runCommand', async (item?: CommandItem | CommandDefinition) => {
			const definition = item instanceof CommandItem ? item.definition : item;
			if (!definition) {
				const picked = await pickCommand();
				if (!picked) {
					return;
				}
				await runCommand(picked);
				return;
			}
			await runCommand(definition);
		})
	);
	try {
		void vscode.commands.executeCommand('workbench.view.extension.commandtt');
	} catch {
		// ignore
	}
	context.subscriptions.push(
		commandsTreeView.onDidExpandElement((event) => {
			if (event.element instanceof CommandGroupItem) {
				expandedCommandGroups.add(event.element.path);
				persistExpandedGroups();
			}
		}),
		commandsTreeView.onDidCollapseElement((event) => {
			if (event.element instanceof CommandGroupItem) {
				expandedCommandGroups.delete(event.element.path);
				persistExpandedGroups();
			}
		})
	);
}

export function deactivate() {}
