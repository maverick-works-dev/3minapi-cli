/**
 * Opens a URL in the default browser — via OS commands, with no runtime dependency (local dashboard).
 * Never throws — the caller has already printed the URL. The result only says whether the open command was launched
 */
import { spawn } from 'node:child_process';

export function openBrowser(url: string, platform: NodeJS.Platform): Promise<boolean> {
	const [command, args] =
		platform === 'darwin'
			? ['open', [url]]
			: platform === 'win32'
				? // `start` takes the window title as its first argument — pass an empty title so the URL is not taken as the title. Quoted so cmd does not interpret `&` etc.
					['cmd', ['/c', 'start', '""', `"${url}"`]]
				: ['xdg-open', [url]];
	return new Promise((resolve) => {
		try {
			const child = spawn(command, args, {
				detached: true,
				stdio: 'ignore',
				windowsVerbatimArguments: platform === 'win32'
			});
			child.once('error', () => resolve(false));
			child.once('spawn', () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}
