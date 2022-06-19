#!/usr/bin/env ts-node
/* eslint-disable no-shadow */
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
import { TwitterApi } from 'twitter-api-v2';
import * as readline from 'readline';

/// Use this if you wanna force recreation the initial database
const REGENERATE_FROM_SCRATCH = false;
const CHUNK_SIZE = 500; // lower this if geth node is hanging
const X2Y2_SALE_TOPIC0 = '0x3cbb63f144840e5b1b0a38a7c19211d2e89de4d7c5faf8b2d3c1776c302d1d33';
const RARIBLE_TOPIC0 = '0xcae9d16f553e92058883de29cb3135dbc0c1e31fd7eace79fef1d80577fe482e';
const NFTX_TOPIC0 = '0xf7735c8cb2a65788ca663fc8415b7c6a66cd6847d58346d8334e8d52a599d3df';
const NFTX_ALTERNATE_TOPIC0 = '0x1cdb5ee3c47e1a706ac452b89698e5e3f2ff4f835ca72dde8936d0f4fcf37d81';
const NFTX_TRANSFER_TOPIC0 = '0x63b13f6307f284441e029836b0c22eb91eb62a7ad555670061157930ce884f4e';
const NFTX_SELL_TOPIC0 = '0x1cdb5ee3c47e1a706ac452b89698e5e3f2ff4f835ca72dde8936d0f4fcf37d81';
const CARGO_TOPIC0 = '0x5535fa724c02f50c6fb4300412f937dbcdf655b0ebd4ecaca9a0d377d0c0d9cc';
const PHUNK_MARKETPLACE_TOPIC0 = '0x975c7be5322a86cddffed1e3e0e55471a764ac2764d25176ceb8e17feef9392c';
const OPENSEA_SALE_TOPIC0 = '0xc4109843e0b7d514e4c093114b863f8e7d8d9a458c372cd51bfe526b588006c9';
const OPENSEA_BID_TOPIC0 = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
const LOOKSRARE_SALE_TOPIC0 = '0x95fb6205e23ff6bda16a2d1dba56b9ad7c783f67c96fa149785052f47696f2be';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

let twitterV1Client:TwitterApi;
let twitterV2Client:TwitterApi;
const readFile = promisify(fs.readFile);
console.log(`opening database at ${process.env.WORK_DIRECTORY + process.env.DATABASE_FILE}`);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);

async function getAuthenticatedV2TwitterClient() {
  let twitterClient = new TwitterApi({
    clientId: process.env.TWITTER_CLIENT_ID,
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
  });
  if (fs.existsSync('refreshToken.txt')) {
    const persistedRefreshToken = fs.readFileSync('refreshToken.txt').toString();
    const {
      client,
      refreshToken,
    } = await twitterClient.refreshOAuth2Token(persistedRefreshToken);
    fs.writeFileSync('refreshToken.txt', refreshToken);
    twitterClient = client;
  } else {
    const { url, codeVerifier } = twitterClient.generateOAuth2AuthLink('http://localhost', { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer:string = await new Promise((resolve) => {
      rl.question(`Lead to ${url}, then enter the code you'll receive in the callback URL: `, resolve);
    });
    await new Promise<void>((resolve) => {
      twitterClient = new TwitterApi({
        clientId: process.env.TWITTER_CLIENT_ID,
        clientSecret: process.env.TWITTER_CLIENT_SECRET,
      });
      twitterClient.loginWithOAuth2({ code: answer, codeVerifier, redirectUri: 'http://localhost' })
        .then(async ({
          client: loggedClient, refreshToken,
        }) => {
          fs.writeFileSync('refreshToken.txt', refreshToken);
          twitterClient = loggedClient;
          resolve();
        }).catch((err) => console.error(err));
    });
  }
  return twitterClient;
}

async function getAuthenticatedV1TwitterClient() {
  let twitterClient:TwitterApi;

  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_ACCESS_TOKEN,
    appSecret: process.env.TWITTER_TOKEN_SECRET,
  });
  const authLink = await twitterClient.generateAuthLink();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer:string = await new Promise((resolve) => {
    rl.question(`Lead to ${authLink.url}, then enter the the code received: `, resolve);
  });
  await new Promise<void>((resolve) => {
    twitterClient = new TwitterApi({
      appKey: process.env.TWITTER_ACCESS_TOKEN,
      appSecret: process.env.TWITTER_TOKEN_SECRET,
      accessToken: authLink.oauth_token,
      accessSecret: authLink.oauth_token_secret,
    });
    twitterClient.login(answer)
      .then(async ({ client: loggedClient, accessToken, accessSecret }) => {
        fs.writeFileSync('twitter-tokens.txt', JSON.stringify({
          accessToken,
          accessSecret,
          tokenSecret: authLink.oauth_token_secret,
        }));
        twitterClient = loggedClient;
        resolve();
      }).catch((err) => console.error(err));
  });

  return twitterClient;
}

async function work() {
  if (process.env.POST_ON_TWITTER === 'true') {
    twitterV2Client = await getAuthenticatedV2TwitterClient();
    if (process.env.HAS_ELEVATED_TWITTER_API_ACCESS === 'true') {
      twitterV1Client = twitterV2Client;
    } else {
      twitterV1Client = await getAuthenticatedV1TwitterClient();
    }
  }

  await createDatabaseIfNeeded();
  if (REGENERATE_FROM_SCRATCH) {
    fs.unlinkSync(`${process.env.WORK_DIRECTORY}last.txt`);
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
  let latest = await web3.eth.getBlockNumber();
  while (last < latest) {
    try {
      const block = await web3.eth.getBlock(last);
      const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
      await sleep(10);
      console.log(`\nretrieving events from block ${last} - ${blockDate.toISOString()}`);

      const lastRequested = last;
      const events = await contract.getPastEvents('Transfer', {
        fromBlock: last,
        toBlock: last + CHUNK_SIZE, // handle blocks by chunks
      });
      console.log(`handling ${events.length} events...`);
      for (const ev of events) {
        process.stdout.write('.');

        last = ev.blockNumber;
        fs.writeFileSync(`${process.env.WORK_DIRECTORY}last.txt`, last.toString());

        const rowExists = await new Promise((resolve) => {
          db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
            if (err) {
              resolve(false);
            }
            resolve(row !== undefined);
          });
        });
        if (rowExists) continue;

        const tr = await web3.eth.getTransactionReceipt(ev.transactionHash);
        let saleFound = false;
        const txBlock = await web3.eth.getBlock(tr.blockNumber);
        const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
        /*
        if (ev.transactionHash === '0x0663ccbe64edd80b6b7f4acdda38c08c859d6bd8a586b980ff14f2940a97273b') {
          console.log('ok');
        } else {
          continue;
        }
        */
        for (const l of tr.logs) {
          // check matching element to get date
          if (l.topics[0] === RARIBLE_TOPIC0
            || l.topics[0] === NFTX_TOPIC0
            || l.topics[0] === NFTX_ALTERNATE_TOPIC0
            || l.topics[0] === CARGO_TOPIC0
            || l.topics[0] === PHUNK_MARKETPLACE_TOPIC0
            || l.topics[0] === OPENSEA_SALE_TOPIC0
            || l.topics[0] === OPENSEA_BID_TOPIC0
            || l.topics[0] === LOOKSRARE_SALE_TOPIC0
            || l.topics[0] === X2Y2_SALE_TOPIC0) {
            saleFound = true;
          }
          if (l.topics[0] === OPENSEA_SALE_TOPIC0
            || l.topics[0] === OPENSEA_BID_TOPIC0) {
            if (l.logIndex !== ev.logIndex + 1) {
              continue;
            }
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = l.topics[0] === OPENSEA_BID_TOPIC0 ? BigInt(`0x${dataSlices[8]}`) / BigInt('1000000000000000') : BigInt(`0x${dataSlices[2]}`) / BigInt('1000000000000000');
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            /*
            db.run('DELETE FROM events WHERE tx = ? AND log_index = ?',
            ev.transactionHash, ev.logIndex);
            */
            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND token_id = ?', [ev.transactionHash, ev.returnValues.tokenId], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              console.log(ev.transactionHash, ev.logIndex);
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'opensea');
              stmt.finalize();
              await saleHappened('opensea', amount, 'ETH', tokenId, ev.transactionHash);
            } else {
              console.log('already exist! we have to debug that!');
            }
            console.log(`\n${txDate.toLocaleString()} - indexed an opensea sale for token #${tokenId} to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === LOOKSRARE_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = BigInt(`0x${dataSlices[6]}`) / BigInt('1000000000000000');
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND token_id = ?', [ev.transactionHash, ev.returnValues.tokenId], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, amount.toString(), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'looksrare');
              stmt.finalize();
              await saleHappened('looksrare', amount, 'ETH', tokenId, ev.transactionHash);
            }
            console.log(`\n${txDate.toLocaleString()} - indexed a looksrare sale for token #${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === X2Y2_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = BigInt(`0x${dataSlices[12]}`) / BigInt('1000000000000000');
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND token_id = ?', [ev.transactionHash, ev.returnValues.tokenId], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, amount.toString(), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'x2y2');
              stmt.finalize();
              await saleHappened('x2y2', amount, 'ETH', tokenId, ev.transactionHash);
            }
            console.log(`\n${txDate.toLocaleString()} - indexed a x2y2 sale for token #${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === PHUNK_MARKETPLACE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = BigInt(`0x${dataSlices[0]}`) / BigInt('1000000000000000');
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND token_id = ?', [ev.transactionHash, ev.returnValues.tokenId], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'phunkmarket');
              stmt.finalize();
              await saleHappened('notlarvalab', amount, 'ETH', tokenId, ev.transactionHash);
            }
            console.log(`\n${txDate.toLocaleString()} - indexed a phunk market place sale for token #${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === RARIBLE_TOPIC0) {
            // rarible
            // 1 -> to
            // 6 -> amount
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const tokenId = ev.returnValues.tokenId;
            // TODO maybe find a better way to identify the proper slice
            if (dataSlices.length < 12) {
              // not the right data slice
              continue;
            }

            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
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
              const re = BigInt(`0x${nftDataSlices[6]}`) / BigInt('1000000000000000');
              return re;
            }).reduce((previousValue, currentValue) => previousValue + currentValue, BigInt(0));

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'rarible');
              stmt.finalize();
            }
            console.log(`\n${txDate.toLocaleString()} - indexed a rarible sale to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
            await saleHappened('rarible', amount, 'ETH', tokenId, ev.transactionHash);
            break;
          } else if (l.topics[0] === NFTX_TOPIC0
            || l.topics[0] === NFTX_ALTERNATE_TOPIC0) {
            // nftx sale
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);

            let relevantTopic = tr.logs.filter((t) => {
              if (t.topics[0] === NFTX_TRANSFER_TOPIC0) {
                return true;
              }
              return false;
            });
            let amount = BigInt('-1');
            if (relevantTopic.length === 0) {
              console.log('\nswap operation, skipping, finding amount elsewhere');
              relevantTopic = tr.logs.filter((t) => {
                if (t.topics[0] === NFTX_SELL_TOPIC0) {
                  return true;
                }
                return false;
              });
              if (relevantTopic.length === 0) {
                console.log('cannot find amount!!');
                break;
              }
              const relevantData = relevantTopic[0].data.substring(2);
              const relevantDataSlice = relevantData.match(/.{1,64}/g);
              amount = BigInt(`0x${relevantDataSlice[1]}`) / BigInt('1000000000000000');
            }

            // find the number of token transferred to adjust amount per token
            const relevantTransferTopic = tr.logs.filter((t) => {
              if (t.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
                && t.topics[1] === '0x000000000000000000000000b39185e33e8c28e0bb3dbbce24da5dea6379ae91') {
                return true;
              }
              return false;
            });

            // we should use the event directly for that
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            amount = BigInt(`0x${dataSlices[1]}`) / BigInt('1000000000000000');
            if (relevantTransferTopic.length > 0) {
              amount /= BigInt(relevantTransferTopic.length);
            }

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'nftx');
              stmt.finalize();
              await saleHappened('nftx', amount, 'ETH', tokenId, ev.transactionHash);
            }
            console.log(`\n${txDate.toLocaleString()} - indexed a nftx sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
            break;
          } else if (l.topics[0] === CARGO_TOPIC0) {
            // cargo sale
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);

            const sourceOwner = dataSlices[12].replace(/^0+/, '').toLowerCase();
            const targetOwner = `0x${dataSlices[0].replace(/^0+/, '')}`.toLowerCase();
            const amount = BigInt(`0x${dataSlices[15]}`) / BigInt('1000000000000000');
            const tokenId = parseInt(dataSlices[10], 16);
            const commission = parseInt(dataSlices[16], 16);

            const amountFloat = new BN(amount.toString())
              .plus(new BN(commission.toString())).toNumber();

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
              stmt.run('sale', sourceOwner, targetOwner, tokenId, amountFloat, txDate.toISOString(), ev.transactionHash, ev.logIndex, 'cargo');
              stmt.finalize();
              await saleHappened('cargo', amount, 'ETH', tokenId.toString(), ev.transactionHash);
            }

            console.log(`\n${txDate.toLocaleString()} - indexed a cargo sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
            break;
          }
        }

        if (!saleFound) {
          // no sale found, index a transfer event
          const rowExists = await new Promise((resolve) => {
            db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [ev.transactionHash, ev.logIndex], (err, row) => {
              if (err) {
                resolve(false);
              }
              resolve(row !== undefined);
            });
          });
          if (!rowExists) {
            const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
            stmt.run('transfer', ev.returnValues.from, ev.returnValues.to, ev.returnValues.tokenId, 0, txDate.toISOString(), ev.transactionHash, ev.logIndex, 'unknown');
          }
        }
      } // end events loop

      // prevent an infinite loop on an empty set of block
      if (lastRequested === last) {
        last += CHUNK_SIZE;
        if (last > latest) last = latest;
      }
      // console.log('\n last < latest', last, '<', latest, last < latest);
      while (last >= latest) {
        // wait for new blocks
        await sleep(10000);
        latest = await web3.eth.getBlockNumber();
        console.log('\nwaiting for new blocks, last:', last, ', latest:', latest, '...');
      }
      /*
      // that's for debugging purpose
      if (initialLast !== last) {
        console.log('!!! last is now', last, initialLast);
      }
      */
    } catch (err) {
      console.log('error received, will try to continue', err);
    }
  }
  console.log('\nended should tail now');
}

function retrieveCurrentBlockIndex():number {
  let last:number = 0;
  const startingBlock = parseInt(process.env.STARTING_BLOCK, 10);
  if (fs.existsSync(`${process.env.WORK_DIRECTORY}last.txt`)) { last = parseInt(fs.readFileSync(`${process.env.WORK_DIRECTORY}last.txt`).toString(), 10); }
  if (Number.isNaN(last) || last < startingBlock) last = startingBlock; // contract creation
  // return 14751897;
  return last;
}

function getWeb3Provider() {
  console.log(`Connecting to web3 provider: ${process.env.GETH_NODE_ENDPOINT}`);
  const provider = new Web3.providers.WebsocketProvider(
    process.env.GETH_NODE_ENDPOINT,
    {
      clientConfig: {
        keepalive: true,
        keepaliveInterval: 5000,
      },
      reconnect: {
        auto: true,
        delay: 4000, // ms
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
    if (fs.existsSync(process.env.DATABASE_FILE)) fs.unlinkSync(process.env.DATABASE_FILE);
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
      db.run('CREATE INDEX idx_type_platform_date ON events(event_type, platform, tx_date);');
      db.run('CREATE INDEX idx_date ON events(tx_date);');
      db.run('CREATE INDEX idx_amount ON events(amount);');
      db.run('CREATE INDEX idx_platform ON events(platform);');
      db.run('CREATE INDEX idx_tx ON events(tx);');
    });
    console.log('Database created...');
  }
}

async function saleHappened(
  marketplace:string,
  amount:bigint,
  token:string,
  nftId:string,
  tx:string,
) {
  console.log('saleHappened', marketplace, amount, token, nftId);
  const displayedAmount = Number(amount * 100n) / 100000;
  // TODO reuse uploaded media
  const mediaId = await twitterV1Client.v1.uploadMedia(`./token_images/phunk${nftId.padStart(4, '0')}.png`);
  twitterV2Client.v2.tweet(`Phunk sale on ${marketplace} for ${displayedAmount}ETH, https://etherscan.io/tx/${tx}`, {
    media: {
      media_ids: [mediaId],
    },
  });
}

async function sleep(msec:number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, msec));
}

work();
