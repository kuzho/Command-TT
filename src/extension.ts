import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

type VariableDefinition = {
	name: string;
	value: string;
	description?: string;
	options?: string[];
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

const CONFIG_SECTION = 'commandTT';
const DEFAULT_GROUP = 'Ungrouped';
const TERMINAL_NAME = 'Command TT';

class VariableItem extends vscode.TreeItem {
	public readonly definition: VariableDefinition;

	constructor(definition: VariableDefinition) {
		super(`\${${definition.name}}`, vscode.TreeItemCollapsibleState.None);
		this.definition = definition;
		this.id = definition.name;
		const hasOptions = definition.options && definition.options.length > 0;
		const displayValue = hasOptions ? `[select: ${definition.options!.join(', ')}]` : definition.value;
		this.description = `= ${displayValue}`;
		const tooltipValue = hasOptions ? `Options: ${definition.options!.join(', ')}` : definition.value;
		this.tooltip = definition.description ? `${definition.description} (${tooltipValue})` : tooltipValue;
		this.contextValue = 'variableItem';
		this.iconPath = new vscode.ThemeIcon('symbol-variable');
	}
}

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

class VariablesProvider implements vscode.TreeDataProvider<VariableItem> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<VariableItem | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	refresh(): void {
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: VariableItem): vscode.TreeItem {
		return element;
	}

	getChildren(): VariableItem[] {
		const variables = getVariables();
		const ordered = shouldSortAlphabetically()
			? [...variables].sort((a, b) => a.name.localeCompare(b.name))
			: variables;
		return ordered.map((variable) => new VariableItem(variable));
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
	return getConfig().get<VariableDefinition[]>('variables', []);
}

function getCommands(): CommandDefinition[] {
	return getConfig().get<CommandDefinition[]>('commands', []);
}

async function updateConfig<T>(key: string, value: T): Promise<void> {
	await getConfig().update(key, value, vscode.ConfigurationTarget.Global);
}

type CommandGroupNode = {
	label: string;
	path: string;
	groups: CommandGroupNode[];
	commands: CommandDefinition[];
};

function buildCommandTree(commands: CommandDefinition[], sortAlphabetically: boolean): CommandGroupNode {
	const root: CommandGroupNode = { label: '', path: '', groups: [], commands: [] };

	for (const command of commands) {
		const rawGroup = command.group?.trim() || DEFAULT_GROUP;
		const parts = rawGroup
			.split('/')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		const groupParts = parts.length > 0 ? parts : [DEFAULT_GROUP];
		let current = root;
		let currentPath = '';
		for (const part of groupParts) {
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

function getLabelText(label: string | vscode.TreeItemLabel | undefined): string | undefined {
	if (!label) {
		return undefined;
	}
	return typeof label === 'string' ? label : label.label;
}

function getVariableNameFromItem(item?: vscode.TreeItem & { definition?: VariableDefinition }): string | undefined {
	if (!item) {
		return undefined;
	}
	if (item.definition?.name) {
		return item.definition.name;
	}
	if (typeof item.id === 'string' && item.id.trim()) {
		return item.id.trim();
	}
	const label = getLabelText(item.label);
	if (!label) {
		return undefined;
	}
	const match = label.match(/^\$\{(.+)\}$/);
	return match ? match[1] : label;
}

function getVariableByName(name: string, variables: VariableDefinition[]): VariableDefinition | undefined {
	return variables.find((v) => v.name === name);
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

		let value: string | undefined;
		if (variable.options && variable.options.length > 0) {
			const selected = await vscode.window.showQuickPick(variable.options, {
				placeHolder: `Select value for ${name}`,
				title: `Choose ${name}`
			});
			value = selected;
		} else {
			value = variable.value;
		}

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
		await vscode.window.showErrorMessage(
			`Missing variables: ${missing.map((name) => `\${${name}}`).join(', ')}`
		);
		return;
	}

	const sendNewLine = definition.sendNewLine ?? true;
	const terminal = getActiveTerminal();
	if (!terminal) {
		await vscode.window.showErrorMessage('No active terminal found.');
		return;
	}
	terminal.show();
	terminal.sendText(result, sendNewLine);
}

async function promptForVariable(existing?: VariableDefinition): Promise<VariableDefinition | undefined> {
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

	const useOptions = await vscode.window.showQuickPick(['No', 'Yes'], {
		placeHolder: 'Do you want to create a select variable with multiple options?',
		title: 'Select Variable Type'
	});
	if (useOptions === undefined) {
		return undefined;
	}

	let value: string | undefined;
	let options: string[] | undefined;

	if (useOptions === 'Yes') {
		const optionsInput = await vscode.window.showInputBox({
			prompt: 'Options (comma-separated, e.g. start,stop,restart)',
			value: existing?.options?.join(',') || '',
			validateInput: (v) => (!v.trim() ? 'At least one option is required.' : undefined)
		});
		if (optionsInput === undefined) {
			return undefined;
		}
		options = optionsInput.split(',').map((o) => o.trim()).filter((o) => o.length > 0);
		value = options[0];
	} else {
		value = await vscode.window.showInputBox({
			prompt: 'Variable value',
			value: existing?.value
		});
		if (value === undefined) {
			return undefined;
		}
	}

	const description = await vscode.window.showInputBox({
		prompt: 'Description (optional)',
		value: existing?.description
	});

	return {
		name: name.trim(),
		value: value.trim(),
		description: description?.trim() || undefined,
		options: options && options.length > 0 ? options : undefined
	};
}

async function promptForCommand(existing?: CommandDefinition): Promise<CommandDefinition | undefined> {
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
		value: existing?.group
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

	return {
		title: title.trim(),
		command: command.trim(),
		group: group.trim() || undefined,
		description: description.trim() || undefined,
		icon: icon.trim() || undefined,
		iconColor: iconColor.trim() || undefined,
		sendNewLine: existing?.sendNewLine
	};
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
			description: variable.value,
			detail: variable.description
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

export function activate(context: vscode.ExtensionContext) {
	const expandedGroups = new Set<string>(
		context.globalState.get<string[]>('commandTT.expandedGroups', [])
	);

	const variablesProvider = new VariablesProvider();
	const commandsProvider = new CommandsProvider(expandedGroups);
	const variablesTreeView = vscode.window.createTreeView('commandTTVariables', {
		treeDataProvider: variablesProvider
	});
	const commandsTreeView = vscode.window.createTreeView('commandTTCommands', {
		treeDataProvider: commandsProvider
	});

	context.subscriptions.push(
		variablesTreeView,
		commandsTreeView,
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				variablesProvider.refresh();
				commandsProvider.refresh();
			}
		}),
		vscode.commands.registerCommand('commandTT.refreshVariables', () => variablesProvider.refresh()),
		vscode.commands.registerCommand('commandTT.refreshCommands', () => commandsProvider.refresh()),
		vscode.commands.registerCommand('commandTT.addVariable', async () => {
			const variable = await promptForVariable();
			if (!variable) {
				return;
			}

			const variables = getVariables();
			const existingIndex = variables.findIndex((item) => item.name === variable.name);
			if (existingIndex >= 0) {
				variables[existingIndex] = variable;
			} else {
				variables.push(variable);
			}
			await updateConfig('variables', variables);
			variablesProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.editVariable', async (item?: VariableItem) => {
			const variableName = getVariableNameFromItem(item);
			const selected = variableName
				? getVariables().find((variable) => variable.name === variableName)
				: await pickVariable();
			if (!selected) {
				return;
			}

			const updated = await promptForVariable(selected);
			if (!updated) {
				return;
			}

			const variables = getVariables().filter((variable) => variable.name !== selected.name);
			variables.push(updated);
			await updateConfig('variables', variables);
			variablesProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.removeVariable', async (item?: VariableItem) => {
			const variableName = getVariableNameFromItem(item);
			const selected = variableName
				? getVariables().find((variable) => variable.name === variableName)
				: await pickVariable();
			if (!selected) {
				return;
			}

			const updated = getVariables().filter((variable) => variable.name !== selected.name);
			await updateConfig('variables', updated);
			variablesProvider.refresh();
		}),
		vscode.commands.registerCommand('commandTT.addCommand', async () => {
			const command = await promptForCommand();
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

	const persistExpandedGroups = (): void => {
		void context.globalState.update('commandTT.expandedGroups', Array.from(expandedGroups));
	};

	outputChannel = vscode.window.createOutputChannel('Command TT');

	// Try to open the activity bar view programmatically so it appears in Extension Dev Host
	try {
		void vscode.commands.executeCommand('workbench.view.extension.commandTT');
	} catch (e) {
		// ignore
	}

	context.subscriptions.push(
		commandsTreeView.onDidExpandElement((event) => {
			const group = event.element;
			if (group instanceof CommandGroupItem) {
				expandedGroups.add(group.path);
				persistExpandedGroups();
			}
		}),
		commandsTreeView.onDidCollapseElement((event) => {
			const group = event.element;
			if (group instanceof CommandGroupItem) {
				expandedGroups.delete(group.path);
				persistExpandedGroups();
			}
		})
	);
}

export function deactivate() {}
