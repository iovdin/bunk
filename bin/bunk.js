#!/usr/bin/env node

const { Command } = require('commander');
const { auth } = require('../lib/auth');
const { fetchEvents } = require('../lib/fetch');

const program = new Command();

program
  .name('bunk')
  .description('bunq OAuth2 helper CLI')
  .version('0.0.1');

program
  .command('auth')
  .description('Authenticate with bunq using OAuth2 and store tokens in keyring')
  .option('-p, --port <port>', 'Local callback server port', (v) => parseInt(v, 10), 4589)
  .option('--host <host>', 'Local callback server host', '127.0.0.1')
  .action(async (opts) => {
    await auth(opts);
  });

program
  .command('fetch')
  .description('Download all bunq events and store in SQLite database')
  .option('-o, --output <path>', 'Output SQLite database path', '~/bunq/index.sqlite')
  .option('-v, --verbose', 'Show detailed progress', false)
  .option('--clean', 'Remove existing database and re-fetch everything', false)
  .action(async (opts) => {
    await fetchEvents(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
