/**
 * Single entry point for CLI domain declarations (types, constants, codes). Other modules import only from here.
 *
 * Rule: domain files import nothing outside domain (no other core module, Node built-in or package).
 * Declarations only; logic stays where it is used. Contract changes flow docs/design/14_cli_host.md → contract.ts → code.
 */
export * from './constants.ts';
export * from './contract.ts';
export * from './errors.ts';
export type * from './types.ts';
