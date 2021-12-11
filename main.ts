#!/usr/bin/env ts-node
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

/// Use this if you wanna force recreation the initial database
const REGENERATE_FROM_SCRATCH = false;
const RARIBLE_TOPIC0 = '0xcae9d16f553e92058883de29cb3135dbc0c1e31fd7eace79fef1d80577fe482e';
const NFTX_TOPIC0 = '0xf7735c8cb2a65788ca663fc8415b7c6a66cd6847d58346d8334e8d52a599d3df';
const NFTX_ALTERNATE_TOPIC0 = '0x1cdb5ee3c47e1a706ac452b89698e5e3f2ff4f835ca72dde8936d0f4fcf37d81';
const NFTX_TRANSFER_TOPIC0 = '0x63b13f6307f284441e029836b0c22eb91eb62a7ad555670061157930ce884f4e';
const CARGO_TOPIC0 = '0x5535fa724c02f50c6fb4300412f937dbcdf655b0ebd4ecaca9a0d377d0c0d9cc';
const RARIBLE_TOKEN_ID_MATCHER_TOPIC0 = '0xeb39ff9fa01427567623bcdf507c38c3661f0febd78123a35951895dc9ec7315';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const readFile = promisify(fs.readFile);
let db = new Database(process.env.DATABASE_FILE);

async function work() {
  await createDatabaseIfNeeded();
  if (REGENERATE_FROM_SCRATCH) {
    fs.unlinkSync('last.txt');
  }
  const abi = await readFile(process.env.TARGET_ABI_FILE);
  let last = retrieveCurrentBlockIndex();
  const json = JSON.parse(abi.toString());
  const provider = getWeb3Provider();
  const web3 = new Web3(provider);
  const contract = new web3.eth.Contract(
    json,
    process.env.TARGET_CONTRACT,
  );
  console.log('starting from block', last);
  const latest = await web3.eth.getBlockNumber();
  while (last < latest) {
    const block = await web3.eth.getBlock(last);
    const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
    await sleep(1000);
    console.log(`\nretrieving events from block ${last} - ${blockDate.toISOString()}`);
    const events = await contract.getPastEvents('Transfer', {
      fromBlock: last,
      toBlock: last + 200, // handle blocks by chunks
    });
    console.log(`handling ${events.length} events...`);
    let lastEvent = null;
    for (const ev of events) {
      lastEvent = ev;
      process.stdout.write('.');
      last = ev.blockNumber;
      fs.writeFileSync('last.txt', last.toString());
      const tr = await web3.eth.getTransactionReceipt(ev.transactionHash);
      for (const l of tr.logs) {
        let txDate;
        // check matching element to get date
        if (l.topics[0] === RARIBLE_TOPIC0
          || l.topics[0] === NFTX_TOPIC0
          || l.topics[0] === NFTX_ALTERNATE_TOPIC0
          || l.topics[0] === CARGO_TOPIC0) {
          const txBlock = await web3.eth.getBlock(tr.blockNumber);
          txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
        }

        if (l.topics[0] === RARIBLE_TOPIC0) {
          // rarible
          // 1 -> to
          // 6 -> amount
          const data = l.data.substring(2);
          const dataSlices = data.match(/.{1,64}/g);

          let tokenId = parseInt(dataSlices[11], 16);
          // TODO maybe find a better way to identify the proper slice
          if (dataSlices.length < 12) {
            // not the right data slice
            continue;
          }

          if (Number.isNaN(tokenId)) {
            tokenId = tr.logs.filter((t) => {
              if (t.topics[0] === RARIBLE_TOKEN_ID_MATCHER_TOPIC0) {
                return true;
              }
              return false;
            }).map((log) => parseInt(log.topics[2], 16))[0];
          }

          const targetOwner = dataSlices[1].replace(/^0+/, '');
          const sourceOwner = dataSlices[2].replace(/^0+/, '');
          const amount = tr.logs.filter((t) => {
            if (t.topics[0] === RARIBLE_TOPIC0) {
              const nftData = t.data.substring(2);
              const nftDataSlices = nftData.match(/.{1,64}/g);
              return nftDataSlices.length === 10 || nftDataSlices.length === 11;
            }
            return false;
          }).map((log) => {
            const nftData = log.data.substring(2);
            const nftDataSlices = nftData.match(/.{1,64}/g);
            const re = parseInt(nftDataSlices[6], 16);
            return re;
          }).reduce((previousValue, currentValue) => previousValue + currentValue, 0);
          const stmt = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?,?,?)');
          stmt.run(sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, 'rarible');
          stmt.finalize();
          console.log(`\n${txDate.toLocaleString()} - indexed a rarible sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          break;
        } else if (l.topics[0] === NFTX_TOPIC0
          || l.topics[0] === NFTX_ALTERNATE_TOPIC0) {
          // nftx sale
          const data = l.data.substring(2);
          const dataSlices = data.match(/.{1,64}/g);

          const relevantTopic = tr.logs.filter((t) => {
            if (t.topics[0] === NFTX_TRANSFER_TOPIC0) {
              return true;
            }
            return false;
          });
          if (relevantTopic.length === 0) {
            console.log('swap operation, skipping');
            break;
          }
          const [tokenId, sourceOwner] = relevantTopic.map((log) => {
            const nftData = log.data.substring(2);
            const nftDataSlices = nftData.match(/.{1,64}/g);
            return [parseInt(nftDataSlices[4], 16), nftDataSlices[2].replace(/^0+/, '')];
          })[0];

          const targetOwner = dataSlices[2].replace(/^0+/, '');
          const amount = parseInt(dataSlices[1], 16);
          const stmt = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?,?,?)');
          stmt.run(sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, 'nftx');
          stmt.finalize();
          console.log(`\n${txDate.toLocaleString()} - indexed a nftx sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          break;
        } else if (l.topics[0] === CARGO_TOPIC0) {
          // cargo sale
          const data = l.data.substring(2);
          const dataSlices = data.match(/.{1,64}/g);

          const sourceOwner = dataSlices[12].replace(/^0+/, '');
          const targetOwner = dataSlices[0].replace(/^0+/, '');
          const amount = parseInt(dataSlices[15], 16);
          const tokenId = parseInt(dataSlices[10], 16);
          const commission = parseInt(dataSlices[16], 16);
          const stmt = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?,?,?)');
          const amountFloat = new BN(amount.toString())
            .plus(new BN(commission.toString())).toNumber();
          stmt.run(sourceOwner, targetOwner, tokenId, amountFloat, txDate.toISOString(), ev.transactionHash, 'cargo');
          stmt.finalize();

          console.log(`\n${txDate.toLocaleString()} - indexed a cargo sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          break;
        }
      }
    }

    // prevent an infinite loop on an empty block
    if (lastEvent == null || last === lastEvent.blockNumber) {
      last += 200;
    }
  }
}

function retrieveCurrentBlockIndex():number {
  let last:number = 0;
  const startingBlock = parseInt(process.env.STARTING_BLOCK, 10);
  if (fs.existsSync('last.txt')) { last = parseInt(fs.readFileSync('last.txt').toString(), 10); }
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
    db.get('SELECT name FROM sqlite_master WHERE type="table" AND name="sales"', [], (err, row) => {
      if (err) {
        resolve(false);
      }
      resolve(row !== undefined);
    });
  });
  if (REGENERATE_FROM_SCRATCH || !tableExists) {
    console.log('Recreating database...');
    fs.unlinkSync(process.env.DATABASE_FILE);
    db = new Database(process.env.DATABASE_FILE);
    db.serialize(() => {
      console.log('create table');
      db.run(
        'CREATE TABLE sales (from_wallet text, to_wallet text, token_id number, amount number, tx_date text, tx text, platform text);',
      );
      console.log('create indexes');
      db.run('CREATE INDEX idx_date ON sales(tx_date);');
      db.run('CREATE INDEX idx_amount ON sales(amount);');
      db.run('CREATE INDEX idx_platform ON sales(platform);');
      db.run('CREATE INDEX idx_tx ON sales(tx);');
    });
    console.log('Database created...');
  }
}

async function sleep(msec:number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, msec));
}

work();
