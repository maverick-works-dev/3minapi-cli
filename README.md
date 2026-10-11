# 3minapi

Run your own machine as a [3Min API](https://3minapi.com) host. An AI you work with (ChatGPT, Claude and other
MCP clients) creates tasks; this CLI fetches them and runs them with worker files you write — plain JavaScript or
TypeScript functions on your PC.

- Node.js **24.12 or newer**, no runtime dependencies, no install scripts
- Works on macOS, Linux and Windows

## Install

```sh
npm install -g 3minapi
3minapi --version
3minapi doctor        # checks Node.js, config, network and proxy settings
```

`npx 3minapi <command>` runs it without installing. On Windows PowerShell, if scripts are disabled, type
`3minapi.cmd` in place of `3minapi`.

## Quick start

1. **Create a host token** on the dashboard: [3minapi.com/dashboard/tasks/local](https://3minapi.com/dashboard/tasks/local).
   It is shown once.
2. **Log in** — the prompt is masked; the token is saved only on this machine.
   ```sh
   3minapi login
   ```
3. **Create the project** (default `~/3minapi`) and a worker:
   ```sh
   3minapi init
   3minapi worker new hello
   3minapi worker run hello --input '{"message":"hi"}'   # runs locally, no API calls
   ```
4. **Start the host** — registers the workers and runs tasks until stopped:
   ```sh
   3minapi start            # or: 3minapi start --detach, then 3minapi stop
   ```

Ask your AI to create a task for the `hello` worker; `3minapi status` and `3minapi logs` show what happened.

## A worker

One file in `workers/` is one worker. The AI reads `description`; `handler` gets the input the AI sent.

```js
export const description = 'Says hello. input: { message: string }';

export async function handler(input, ctx) {
	ctx.log(`got ${input.message}`);
	return { reply: `hello, ${input.message}` };
}
```

Returning completes the task with that value; throwing fails it with the error message. `ctx.signal` aborts on
cancel or timeout. `3minapi worker new` writes a template that documents every option.

## Using it from an AI coding agent

`3minapi init` writes `AGENTS.md` (and a `CLAUDE.md` that imports it) into the project, so Claude Code, Codex and
other agents know which files to edit, which commands to run and which files never to touch. The same text is
printed by:

```sh
3minapi guide
```

Every command takes `--json` for machine-readable output. Log in yourself — never paste the host token into a chat.

## Update

```sh
3minapi stop                 # if start is running
npm install -g 3minapi@latest
```

The CLI tells you when a newer version is recommended, and stops with exit code 6 when it is too old to connect.

## Links

- Guide: [3minapi.com](https://3minapi.com)
- Security policy: [SECURITY.md](SECURITY.md)
- License: [MIT](LICENSE)
