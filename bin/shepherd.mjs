#!/usr/bin/env node
// `shepherd`: the command table, with its help, is in src/cli.mjs (`shepherd help`).
import { quietPipes } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';

// SHEPHERD_HOME stands in for the home folder: every state, config and Copilot path Shepherd reads or writes sits under it. A harness
// that runs agents on scratch work (a skill evaluation) sets it, so nothing the agent runs can reach the real queue, config or app.
if (process.env.SHEPHERD_HOME) process.env.HOME = process.env.SHEPHERD_HOME;
const { main } = await import('../src/cli.mjs');

quietPipes(process);
const argv = process.argv.slice(2);
const [first, ...rest] = argv;
const words = first === undefined ? ['help'] : first === '--version' || first === '-v' ? ['version', ...rest] : argv;
process.exitCode = await main(words, process);
