import type { Command } from '../core/domain/index.ts';
import { login, logout, status } from './auth.ts';
import { dashboard } from './dashboard.ts';
import { doctor } from './doctor.ts';
import { guide } from './guide.ts';
import { init } from './init.ts';
import { logs } from './logs.ts';
import { paths } from './paths.ts';
import { reload } from './reload.ts';
import { start } from './start.ts';
import { stop } from './stop.ts';
import { tasks } from './tasks.ts';
import { worker } from './worker.ts';

/** Order shown in help = the order a first-time user needs. Groups (worker) are expanded into their subcommands */
export const commands: Command[] = [
	login,
	init,
	worker,
	start,
	reload,
	stop,
	status,
	logs,
	dashboard,
	tasks,
	paths,
	guide,
	logout,
	doctor
];
