#!/usr/bin/env node
// `shepherd`: the command table, with its help, is in src/cli.mjs (`shepherd help`).
import { quietPipes } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';
import { main } from '../src/cli.mjs';

quietPipes(process);
const argv = process.argv.slice(2);
const [first, ...rest] = argv;
const words = first === undefined ? ['help'] : first === '--version' || first === '-v' ? ['version', ...rest] : argv;
process.exitCode = await main(words, process);
