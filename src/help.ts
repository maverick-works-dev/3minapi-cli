import { BIN, DEFAULT_API_URL, type Command, type OptionSpec } from './core/domain/index.ts';

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
	help: { type: 'boolean', short: 'h', description: 'Show help' },
	version: { type: 'boolean', description: 'Show the CLI version' },
	json: { type: 'boolean', description: 'Print the result as JSON on stdout' },
	color: { type: 'boolean', description: 'Force color on or off (--no-color)' },
	'api-url': {
		type: 'string',
		valueName: 'url',
		description: `API base URL (default ${DEFAULT_API_URL})`
	},
	config: {
		type: 'string',
		valueName: 'file',
		description: "Project config file (default: this host's project — '3minapi init')"
	}
};

export function rootHelp(commands: Command[], version: string): string {
	// Groups list their subcommands by the name actually typed — `worker new`, `worker results list`
	const flat = (c: Command): Command[] => (c.subcommands ? c.subcommands.flatMap(flat) : [c]);
	const rows = commands.flatMap(flat);
	const width = Math.max(...rows.map((c) => c.name.length)) + 2;
	const lines = [
		`${BIN} ${version} — run this machine as a 3Min API host for your own worker files`,
		'',
		`Usage: ${BIN} <command> [options]`,
		'',
		'Commands:',
		...rows.map(
			(c) => `  ${c.name.padEnd(width)}${c.summary}${c.pendingIssue ? ' (not yet available)' : ''}`
		),
		'',
		'Global options:',
		...formatOptions(GLOBAL_OPTIONS),
		'',
		`Run '${BIN} help <command>' for details on a command.`
	];
	return lines.join('\n');
}

export function commandHelp(cmd: Command): string {
	const lines = [`Usage: ${BIN} ${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''}`, '', cmd.summary];
	if (cmd.description) lines.push('', cmd.description);
	if (cmd.pendingIssue) lines.push('', `Not yet available — tracked in ${cmd.pendingIssue}.`);
	if (Object.keys(cmd.options).length > 0)
		lines.push('', 'Options:', ...formatOptions(cmd.options));
	lines.push('', 'Global options:', ...formatOptions(GLOBAL_OPTIONS));
	return lines.join('\n');
}

/** Help for a subcommand group (`3minapi worker`) */
export function groupHelp(group: Command): string {
	const subs = group.subcommands ?? [];
	const width = Math.max(...subs.map((c) => c.name.length)) + 2;
	const lines = [
		`Usage: ${BIN} ${group.name} <command> [options]`,
		'',
		group.summary,
		...(group.description ? ['', group.description] : []),
		'',
		'Commands:',
		...subs.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
		'',
		`Run '${BIN} help ${group.name} <command>' for details on a command.`
	];
	return lines.join('\n');
}

function formatOptions(options: Record<string, OptionSpec>): string[] {
	const rows = Object.entries(options).map(([name, spec]) => {
		const flag =
			spec.type === 'boolean' && name === 'color'
				? '--[no-]color'
				: spec.negated
					? `--no-${name}`
					: `--${name}`;
		const value = spec.type === 'string' ? ` <${spec.valueName ?? 'value'}>` : '';
		const short = spec.short ? `-${spec.short}, ` : '    ';
		return [`${short}${flag}${value}`, spec.description] as const;
	});
	const width = Math.max(...rows.map(([left]) => left.length)) + 2;
	return rows.map(([left, desc]) => `  ${left.padEnd(width)}${desc}`);
}

// ── `--json` help — lets AI agents explore the CLI on their own. Same source (Command, OptionSpec) as the text help ──

export interface OptionJson {
	name: string;
	type: 'boolean' | 'string';
	short?: string;
	valueName?: string;
	negated?: boolean;
	multiple?: boolean;
	description: string;
}

function optionsJson(options: Record<string, OptionSpec>): OptionJson[] {
	return Object.entries(options).map(([name, spec]) => ({
		name: spec.negated ? `no-${name}` : name,
		type: spec.type,
		...(spec.short ? { short: spec.short } : {}),
		...(spec.type === 'string' ? { valueName: spec.valueName ?? 'value' } : {}),
		...(spec.negated ? { negated: true } : {}),
		...(spec.multiple ? { multiple: true } : {}),
		description: spec.description
	}));
}

function commandJson(cmd: Command) {
	return {
		name: cmd.name,
		summary: cmd.summary,
		usage: `${BIN} ${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''}`,
		...(cmd.description ? { description: cmd.description } : {}),
		args: cmd.args,
		options: optionsJson(cmd.options),
		...(cmd.pendingIssue ? { available: false } : {})
	};
}

/** `3minapi --json` — groups by expanded name (`worker results list`); same list as rootHelp */
export function rootHelpJson(commands: Command[], version: string) {
	const flat = (c: Command): Command[] => (c.subcommands ? c.subcommands.flatMap(flat) : [c]);
	return {
		name: BIN,
		version,
		commands: commands.flatMap(flat).map(commandJson),
		globalOptions: optionsJson(GLOBAL_OPTIONS)
	};
}

/** `help <cmd> --json`, `<cmd> --help --json` */
export function commandHelpJson(cmd: Command) {
	return { ...commandJson(cmd), globalOptions: optionsJson(GLOBAL_OPTIONS) };
}

export interface GroupHelpJson {
	name: string;
	summary: string;
	description?: string;
	commands: (GroupHelpJson | ReturnType<typeof commandJson>)[];
}

/** `worker --json` — a group */
export function groupHelpJson(group: Command): GroupHelpJson {
	return {
		name: group.name,
		summary: group.summary,
		...(group.description ? { description: group.description } : {}),
		commands: (group.subcommands ?? []).map((c) =>
			c.subcommands ? groupHelpJson(c) : commandJson(c)
		)
	};
}

/** Suggests a command for a typo — the closest within edit distance 2 */
export function suggest(input: string, names: string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = 3;
	for (const name of names) {
		const d = distance(input, name);
		if (d < bestDistance) {
			best = name;
			bestDistance = d;
		}
	}
	return best;
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[b.length];
}
