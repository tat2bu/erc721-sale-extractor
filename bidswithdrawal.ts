#!/usr/bin/env ts-node
/* eslint-disable no-loop-func */
/* eslint-disable prefer-destructuring */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-use-before-define */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */

import Web3 from 'web3';
import BN from 'bignumber.js';
import { promisify } from 'util';
import fs from 'fs';
import { Database } from 'sqlite3';
import dotenv from 'dotenv';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const REGENERATE_FROM_SCRATCH = false;
const readFile = promisify(fs.readFile);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);

async function work() {
  await createDatabaseIfNeeded();
  if (REGENERATE_FROM_SCRATCH) {
    fs.unlinkSync('lastbidswithdrawn.txt');
  }
  const abi = await readFile(process.env.TARGET_ABI_FILE_MARKETPLACE as string);
  let last = retrieveCurrentBlockIndex();
  const json = JSON.parse(abi.toString());
  const provider = getWeb3Provider();
  const web3 = new Web3(provider);
  const contract = new web3.eth.Contract(
    json,
    process.env.TARGET_CONTRACT_MARKETPLACE,
  );
  console.log('starting from block', last);
  let latest = await web3.eth.getBlockNumber();
  while (last < latest) {
    const block = await web3.eth.getBlock(last);
    const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
    await sleep(200);
    console.log(`\nretrieving events from block ${last} - ${blockDate.toISOString()}`);

    const events = await contract.getPastEvents('PhunkBidWithdrawn', {
      fromBlock: last,
      toBlock: last + 1000, // handle blocks by chunks
    });
    fs.writeFileSync(`${process.env.WORK_DIRECTORY}/lastbidswithdrawn.txt`, last.toString());
    console.log(`handling ${events.length} events...`);
    let lastEvent = null;
    for (const ev of events) {
      lastEvent = ev;
      process.stdout.write('.');
      last = ev.blockNumber;
      fs.writeFileSync(`${process.env.WORK_DIRECTORY}/lastbidswithdrawn.txt`, last.toString());

      const rowExists = await new Promise((resolve) => {
        db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
          if (err) {
            resolve(false);
          }
          resolve(row !== undefined);
        });
      });
      if (rowExists) continue;

      const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
      const sourceOwner = ev.returnValues.fromAddress;
      const tokenId = ev.returnValues.phunkIndex;
      const amount = ev.returnValues.value;
      const txBlock = await web3.eth.getBlock(ev.blockNumber);
      const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
      console.log(ev.transactionHash, ev.logIndex);
      stmt.run('bidwithrawn', sourceOwner, 'na', tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'phunkmarket');
    }

    // prevent an infinite loop on an empty set of block
    // @ts-ignore: Object is possibly 'null'.
    if (lastEvent === null || last === lastEvent.blockNumber) {
      last += 200;
    }
    while (last >= latest) {
      // wait for new blocks
      await sleep(10000);
      latest = await web3.eth.getBlockNumber();
      console.log('\nwaiting for new blocks, last:', last, ', latest:', latest, '...');
    }
  }
}

function retrieveCurrentBlockIndex():number {
  let last:number = 0;
  const startingBlock = parseInt(process.env.STARTING_BLOCK_MARKETPLACE, 10);
  if (fs.existsSync(`${process.env.WORK_DIRECTORY}/lastbidswithdrawn.txt`)) { last = parseInt(fs.readFileSync(`${process.env.WORK_DIRECTORY}/lastbidswithdrawn.txt`).toString(), 10); }
  if (Number.isNaN(last) || last < startingBlock) last = startingBlock; // contract creation
  return last;
}

function getWeb3Provider() {
  console.log(`Connecting to web3 provider: ${process.env.GETH_NODE_ENDPOINT}`);
  const provider = new Web3.providers.WebsocketProvider(
    process.env.GETH_NODE_ENDPOINT,
    {
      clientConfig: {
        keepalive: true,
        keepaliveInterval: 10000,
      },
      reconnect: {
        auto: true,
        delay: 1000, // ms
        maxAttempts: 10,
        onTimeout: true,
      },
    },
  );
  return provider;
}

async function createDatabaseIfNeeded() {
  const tableExists = await new Promise((resolve) => {
    db.get('SELECT name FROM sqlite_master WHERE type="table" AND name="events"', [], (err, row) => {
      if (err) {
        resolve(false);
      }
      resolve(row !== undefined);
    });
  });
  if (REGENERATE_FROM_SCRATCH || !tableExists) {
    console.log('Recreating database...');
    fs.unlinkSync(process.env.DATABASE_FILE);
    db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);
    db.serialize(() => {
      console.log('create table');
      db.run(
        `CREATE TABLE events (
          event_type text, from_wallet text, to_wallet text, 
          token_id number, amount number, tx_date text, tx text, 
          log_index number, platform text,
          UNIQUE(tx, log_index)
        );`,
      );
      console.log('create indexes');
      db.run('CREATE INDEX idx_type_date ON events(event_type, tx_date);');
      db.run('CREATE INDEX idx_date ON events(tx_date);');
      db.run('CREATE INDEX idx_amount ON events(amount);');
      db.run('CREATE INDEX idx_platform ON events(platform);');
      db.run('CREATE INDEX idx_tx ON events(tx);');
    });
    console.log('Database created...');
  }
}

async function sleep(msec:number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, msec));
}

work();
