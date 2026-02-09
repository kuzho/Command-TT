import * as vscode from 'vscode';

type VariableDefinition = {
	name: string;
	value: string;
	description?: string;
};

type CommandDefinition = {
	title: string;
	command: string;
	group?: string;
	description?: string;
	icon?: string;
	iconColor?: string;
};

const CONFIG_SECTION = 'commandTT';
const DEFAULT_GROUP = 'Ungrouped';
const TERMINAL_NAME = 'Command TT';

class VariableItem extends vscode.TreeItem {
	public readonly definition: VariableDefinition;

	constructor(definition: VariableDefinition) {
		super(`\${${definition.name}}`, vscode.TreeItemCollapsibleState.None);
		this.definition = definition;
		this.id = definition.name;
		this.description = `= ${definition.value}`;
		this.tooltip = definition.description || `${definition.name}: ${definition.value}`;
		this.contextValue = 'variableItem';
		this.iconPath = new vscode.ThemeIcon('symbol-variable');
	}
}

class CommandGroupItem extends vscode.TreeItem {
	public readonly path: string;

	constructor(label: string, path: string) {
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
		this.path = path;
		this.contextValue = 'commandGroup';
		this.iconPath = new vscode.ThemeIcon('folder');
	}
}

class CommandItem extends vscode.TreeItem {
	public readonly definition: CommandDefinition;

	constructor(definition: CommandDefinition) {
		super(definition.title, vscode.TreeItemCollapsibleState.None);
		this.definition = definition;
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
		return variables
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((variable) => new VariableItem(variable));
	}
}

class CommandsProvider implements vscode.TreeDataProvider<CommandGroupItem | CommandItem> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<CommandGroupItem | CommandItem | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	refresh(): void {
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: CommandGroupItem | CommandItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: CommandGroupItem): Array<CommandGroupItem | CommandItem> {
		const commands = getCommands();
		const tree = buildCommandTree(commands);

		if (!element) {
			return tree.groups
				.sort((a, b) => a.label.localeCompare(b.label))
				.map((group) => new CommandGroupItem(group.label, group.path));
		}

		const node = findGroupNode(tree, element.path);
		if (!node) {
			return [];
		}

		const children: Array<CommandGroupItem | CommandItem> = [];
		for (const group of node.groups) {
			children.push(new CommandGroupItem(group.label, group.path));
		}
		for (const command of node.commands) {
			children.push(new CommandItem(command));
		}

		return children
			.sort((a, b) => getLabelText(a.label)?.localeCompare(getLabelText(b.label) ?? '') ?? 0);
	}
}

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
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

function buildCommandTree(commands: CommandDefinition[]): CommandGroupNode {
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

function buildVariableMap(variables: VariableDefinition[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const variable of variables) {
		map.set(variable.name, variable.value);
	}
	return map;
}

function substituteVariables(text: string, variables: VariableDefinition[]): { result: string; missing: string[] } {
	const variableMap = buildVariableMap(variables);
	const missing = new Set<string>();
	const result = text.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (_, name: string) => {
		const value = variableMap.get(name);
		if (value === undefined) {
			missing.add(name);
			return `\${${name}}`;
		}
		return value;
	});

	return { result, missing: Array.from(missing) };
}

function getActiveTerminal(): vscode.Terminal | undefined {
	return vscode.window.activeTerminal;
}

async function runCommand(definition: CommandDefinition): Promise<void> {
	const variables = getVariables();
	const { result, missing } = substituteVariables(definition.command, variables);
	if (missing.length > 0) {
		await vscode.window.showErrorMessage(
			`Missing variables: ${missing.map((name) => `\${${name}}`).join(', ')}`
		);
		return;
	}

	const sendNewLine = getConfig().get<boolean>('sendNewLine', true);
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

	const value = await vscode.window.showInputBox({
		prompt: 'Variable value',
		value: existing?.value
	});
	if (value === undefined) {
		return undefined;
	}

	const description = await vscode.window.showInputBox({
		prompt: 'Description (optional)',
		value: existing?.description
	});

	return {
		name: name.trim(),
		value,
		description: description?.trim() || undefined
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
		iconColor: iconColor.trim() || undefined
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

	const variablesProvider = new VariablesProvider();
	const commandsProvider = new CommandsProvider();

	context.subscriptions.push(
		vscode.window.createTreeView('commandTTVariables', { treeDataProvider: variablesProvider }),
		vscode.window.createTreeView('commandTTCommands', { treeDataProvider: commandsProvider }),
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
}

export function deactivate() {}
