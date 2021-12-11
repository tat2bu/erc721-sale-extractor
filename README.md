# ERC721 sales extractor

The `main.ts` script scrapes the blockchain datas and extract structured informations about sales of a specific contract (here, the cryptophunks) into a SQLite database. It currently supports Cargo, Rarible and NFTX sales.

The extracted datas are structured the following way in the generated database:

```
------------------
sales
------------------
from_wallet TEXT
to_wallet   TEXT
token_id    NUMBER
amount      NUMBER
tx_date     TEXT
tx          TEXT
platform    TEXT
```

It restarts where it stopped, if you want to start from the beginning, change the value of the `REGENERATE_FROM_SCRATCH` constant.

## Setup

Copy the `.env` file to `.env.local` to setup your local configuration, you'll need a geth node (infura and alchemy provide this with good free tiers). Then start the scraper using `ts-node`: `npx ts-node main.ts`, or `ts-node main.ts` or even `main.ts` depending on your system configuration.

## Sample API

An example API that uses these datas is implemented in the `server.js` file, for now, it serves a single endpoint at `/api/datas` which returns the aggregated datas day by day, but new endpoints could be easily developed using the datas available in the database. Also, a demo chart using these aggregated data is served by the API server at `http://localhost:3000/app`.

You can start it using `npm start`.

## Things to be implemented

- Better code structure using callbacks, so this could be used for other purposes (like a sale bot)
- Automatically follow new events when reaching the last (and current) block of the blockchain
- Implement Opensea sales
- Extract specific traits from the tokens into the database and index them.
