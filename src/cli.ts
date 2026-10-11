/**
 * Command dispatch. Side effects (process exit, global state) live in bin.ts; this only returns an exit code — tests call it directly.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { commands } from './commands/index.ts';
import { loadConfig } from './core/config.ts';
import { describeError, errorDocument } from './core/error-report.ts';
import {
	BIN,
	CliError,
	ExitCode,
	UsageError,
	type Command,
	type CommandContext,
	type ConfigKey,
	type InputStream,
	type OptionValues
} from './core/domain/index.ts';
import { Output, type Stream } from './core/output.ts';
import { resolveDirs } from './core/paths.ts';
import { resolveProject, writeProjectRecord } from './core/project.ts';
import {
	GLOBAL_OPTIONS,
	commandHelp,
	commandHelpJson,
	groupHelp,
	groupHelpJson,
	rootHelp,
	rootHelpJson,
	suggest
} from './help.ts';

export interface Io {
	stdout: Stream;
	stderr: Stream;
	stdin: InputStream;
	env: NodeJS.ProcessEnv;
	cwd: string;
	platform: NodeJS.Platform;
	home: string;
	/** Current time — tests move it. Defaults to Date.now */
	now?: () => number;
	/** Stops long-running commands (`logs -f`, `start`) — bin.ts aborts it on Ctrl+C */
	signal?: AbortSignal;
	/** CommandContext.claimInterrupt — supplied by bin.ts */
	claimInterrupt?: () => void;
	/** CommandContext.chdir — defaults to process.chdir. Tests running in the same process pass one that does not change it */
	chdir?: (dir: string) => void;
}

export const VERSION: string = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

export async function main(argv: string[], io: Io): Promise<ExitCode> {
	// Output format flags are read before any parse error — so error messages follow the same rules (color)
	const out = new Output({
		stdout: io.stdout,
		stderr: io.stderr,
		env: io.env,
		json: argv.includes('--json'),
		color: argv.includes('--no-color') ? false : argv.includes('--color') ? true : undefined
	});

	try {
		return await dispatch(argv, io, out);
	} catch (err) {
		// Humans get the stderr message, machines the `--json` error document (stdout) — docs/design/15_cli.md §4
		const report = describeError(err);
		if (report.kind === 'bug') {
			out.error(`unexpected error: ${report.stack}`);
			out.info('This is a bug in the CLI. Please report it with the output above.');
		} else {
			out.error(report.message);
		}
		out.errorResult(errorDocument(report));
		return report.exitCode;
	}
}

async function dispatch(argv: string[], io: Io, out: Output): Promise<ExitCode> {
	const index = commandIndex(argv);
	const name = index === -1 ? undefined : argv[index];
	let rest = index === -1 ? argv : [...argv.slice(0, index), ...argv.slice(index + 1)];

	// Help — with `--json`, the same content as JSON
	const showRoot = () => out.result(rootHelpJson(commands, VERSION), rootHelp(commands, VERSION));
	const showCommand = (c: Command) =>
		c.subcommands
			? out.result(groupHelpJson(c), groupHelp(c))
			: out.result(commandHelpJson(c), commandHelp(c));

	if (name === undefined) {
		const { values } = parse(rest, GLOBAL_OPTIONS, false, null);
		if (values.version) {
			out.result({ version: VERSION }, VERSION);
			return ExitCode.Ok;
		}
		showRoot();
		return ExitCode.Ok;
	}

	if (name === 'help') {
		const { positionals } = parse(rest, GLOBAL_OPTIONS, true, null);
		if (positionals.length === 0) {
			showRoot();
			return ExitCode.Ok;
		}
		// Groups can nest — `help worker results query`
		let target = findCommand(positionals[0]);
		for (const p of positionals.slice(1)) {
			if (!target.subcommands) break;
			target = findSub(target, p);
		}
		showCommand(target);
		return ExitCode.Ok;
	}

	let cmd = findCommand(name);
	while (cmd.subcommands) {
		// `worker new ...` — the first positional after a group is the subcommand. Without one (`worker`, `worker --help`), group help.
		// Nested groups (`worker results list`) descend one level at a time by the same rule
		const i = commandIndex(rest);
		if (i === -1) {
			showCommand(cmd);
			return ExitCode.Ok;
		}
		const sub = findSub(cmd, rest[i]);
		rest = [...rest.slice(0, i), ...rest.slice(i + 1)];
		cmd = sub;
	}
	// clig.dev: with -h/--help, ignore other arguments and print help only (before argument errors)
	if (rest.includes('--help') || rest.includes('-h')) {
		showCommand(cmd);
		return ExitCode.Ok;
	}

	const { values, positionals } = parse(
		rest,
		{ ...GLOBAL_OPTIONS, ...cmd.options },
		true,
		cmd.name
	);
	if (values.version) {
		out.result({ version: VERSION }, VERSION);
		return ExitCode.Ok;
	}
	if (positionals.length < cmd.args.min || positionals.length > cmd.args.max) {
		throw new UsageError(
			`usage: ${BIN} ${cmd.name} ${cmd.usage}\nRun '${BIN} help ${cmd.name}' for details.`
		);
	}

	const dirs = resolveDirs({ platform: io.platform, env: io.env, home: io.home });
	let resolved: string | null | undefined;
	let configWarned = false;
	const ctx: CommandContext = {
		positionals,
		values,
		out,
		stdin: io.stdin,
		env: io.env,
		cwd: io.cwd,
		home: io.home,
		platform: io.platform,
		dirs,
		version: VERSION,
		now: io.now ?? Date.now,
		signal: io.signal ?? new AbortController().signal,
		claimInterrupt: () => io.claimInterrupt?.(),
		chdir: io.chdir ?? ((dir) => process.chdir(dir)),
		loadConfig: () => {
			const config = loadConfig({
				cwd: io.cwd,
				env: io.env,
				configDir: dirs.config,
				configFile: values.config as string | undefined,
				...(values.config === undefined ? { projectFile: hostProject() } : {}),
				flags: configFlags(values, cmd.name)
			});
			// Config warnings (unknown keys, ignored apiUrl) once per command — doctor shows them as its own check rows
			if (!configWarned && cmd.name !== 'doctor') {
				configWarned = true;
				for (const w of config.warnings) out.warn(w);
			}
			return config;
		}
	};
	return cmd.run(ctx);

	/**
	 * This host's project (core/project.ts). Recording and notices happen once even if called several times in one command.
	 * A recording failure is only a warning — this command runs with the project it found
	 */
	function hostProject(): string | null {
		if (resolved !== undefined) return resolved;
		const r = resolveProject({
			cwd: io.cwd,
			dataDir: dirs.data,
			platform: io.platform,
			home: io.home
		});
		if (r.record !== null) {
			try {
				writeProjectRecord(dirs.data, r.record, (io.now ?? Date.now)());
			} catch (err) {
				out.warn(`could not record this host's project: ${(err as Error).message}`);
			}
		}
		for (const notice of r.notices) out.warn(notice);
		resolved = r.projectFile;
		return resolved;
	}
}

/**
 * The config layering's `flag` layer — global `--api-url`, start's `--port` and `--mode`. Only start's `--port` is a config value (localServerPort, 1024+) —
 * dashboard's `--port` is its own port; passing it would turn values below 1024 into an unrelated config error (exit 3) (#1410)
 */
export function configFlags(
	values: OptionValues,
	command: string
): Partial<Record<ConfigKey, string>> {
	const flags: Partial<Record<ConfigKey, string>> = {};
	if (typeof values['api-url'] === 'string') flags.apiUrl = values['api-url'];
	if (command === 'start' && typeof values.port === 'string') flags.localServerPort = values.port;
	if (command === 'start' && typeof values.mode === 'string') flags.receiveMode = values.mode;
	return flags;
}

/** Index of the first positional (= the command). Skips the value of global options that take one (`--api-url x`) */
function commandIndex(argv: string[]): number {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--') return i + 1 < argv.length ? i + 1 : -1;
		if (!arg.startsWith('-') || arg === '-') return i;
		const long = arg.startsWith('--') ? arg.slice(2) : undefined;
		if (long !== undefined && !long.includes('=') && GLOBAL_OPTIONS[long]?.type === 'string') i++;
	}
	return -1;
}

function findCommand(name: string): Command {
	const cmd = commands.find((c) => c.name === name);
	if (cmd) return cmd;
	const guess = suggest(
		name,
		commands.map((c) => c.name)
	);
	throw new UsageError(
		`unknown command "${name}".` +
			(guess ? ` Did you mean "${guess}"?` : '') +
			`\nRun '${BIN} --help' to see all commands.`
	);
}

function findSub(group: Command, name: string): Command {
	const subs = group.subcommands ?? [];
	const short = (c: Command) => c.name.slice(group.name.length + 1);
	const sub = subs.find((c) => short(c) === name);
	if (sub) return sub;
	const guess = suggest(name, subs.map(short));
	throw new UsageError(
		`unknown command "${group.name} ${name}".` +
			(guess ? ` Did you mean "${group.name} ${guess}"?` : '') +
			`\nRun '${BIN} ${group.name} --help' to see its commands.`
	);
}

function parse(
	args: string[],
	options: typeof GLOBAL_OPTIONS,
	allowPositionals: boolean,
	/** Command name for error hints (`help <cmd>`). null = no command */
	command: string | null
): { values: OptionValues; positionals: string[] } {
	// Strip help-only fields so parseArgs rejects unknown keys
	const config = Object.fromEntries(
		Object.entries(options).map(([k, { description: _d, valueName: _v, negated: _n, ...spec }]) => [
			k,
			spec
		])
	);
	let parsed;
	try {
		parsed = parseArgs({
			args,
			options: config,
			strict: true,
			allowPositionals,
			allowNegative: true,
			tokens: true
		});
	} catch (err) {
		if (
			err instanceof TypeError &&
			'code' in err &&
			String(err.code).startsWith('ERR_PARSE_ARGS')
		) {
			throw new UsageError(parseErrorMessage(err, String(err.code), options, command));
		}
		throw err;
	}
	// allowNegative adds `--no-` to every boolean — `--no-lan`, `--no-yes`, `--no-json` would be accepted as "off" without error
	// and run something unintended. Only flags made for negation (negated) and `--no-color` are accepted (#1412)
	for (const token of parsed.tokens) {
		if (token.kind !== 'option' || !token.rawName.startsWith('--no-')) continue;
		const spec = options[token.name];
		if (spec?.negated || token.name === 'color') continue;
		throw new UsageError(
			parseErrorMessage(
				new Error(`Unknown option '${token.rawName}'`),
				'ERR_PARSE_ARGS_UNKNOWN_OPTION',
				options,
				command
			)
		);
	}
	return { values: parsed.values, positionals: parsed.positionals };
}

/**
 * parseArgs error → a short message plus the next step. Node's original text is long ("To specify a positional argument starting with a '-'…")
 * and does not say what to type. Unknown flags get the closest match among the command's and global options
 */
function parseErrorMessage(
	err: Error,
	code: string,
	options: typeof GLOBAL_OPTIONS,
	command: string | null
): string {
	const help = command ? `Run '${BIN} help ${command}' for its options.` : `Run '${BIN} --help'.`;
	const quoted = /'([^']+)'/.exec(err.message)?.[1];
	if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && quoted) {
		const names = Object.entries(options).flatMap(([name, spec]) => [
			`--${name}`,
			...(spec.short ? [`-${spec.short}`] : []),
			...(spec.negated || name === 'color' ? [`--no-${name}`] : [])
		]);
		const guess = suggest(quoted, names);
		return `unknown option "${quoted}".${guess ? ` Did you mean "${guess}"?` : ''}\n${help}`;
	}
	// Anything else (missing value, flag that takes no value, etc.) — only Node's first sentence
	const first = err.message.split(/\.\s/)[0].replace(/\.$/, '');
	return `${first}.\n${help}`;
}
