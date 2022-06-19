# ERC721 sales extractor

The `main.ts` script scrapes the blockchain datas and extract structured informations about sales of a specific contract (here, the cryptophunks) into a SQLite database. It currently supports Cargo, Rarible and NFTX sales.

The extracted datas are structured the following way in the generated sqlite3 database:

```
------------------
events
------------------
event_type TEXT
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

An example API that uses these datas is implemented in the `server.js` file, for now, it serves a single endpoint at `/api/datas` which returns the aggregated datas day by day, but new endpoints could be easily developed using the datas available in the database. You can find other endpoints by reading the `server.js` source code.

Also, a demo chart using these aggregated data is served by the API server at `http://localhost:3000/app`.

You can start it using `npm start`, that will concurrently start the scrapping processes as well as the API server.

## Twitter bot mode

You can setup the extractor to automatically post on Twitter whenever a sale is detected. For that you'll need a few more environment variables:

```
POST_ON_TWITTER=true
HAS_ELEVATED_TWITTER_API_ACCESS=false
TWITTER_ACCESS_TOKEN=<TWITTER_V1_API_AUTHENTICATION>
TWITTER_TOKEN_SECRET=<TWITTER_V1_API_AUTHENTICATION>
TWITTER_CLIENT_ID=<TWITTER_V2_API_AUTHENTICATION>
TWITTER_CLIENT_SECRET=<TWITTER_V2_API_AUTHENTICATION>
```

Because Twitter API [is incomplete](https://twittercommunity.com/t/how-to-show-an-image-in-a-v2-api-tweet/163169), if you don't have an elevated access, you'll need to authenticate twice during bot startup, once for the V1 API, and another time for the V2 one.

If you have an elevated access, the credentials will be stored locally, and the interactive setup will only happen once, and you'll have consequently the possibility to install the bot as a service.

You'll have to fill a `token_images` folder with the images of the NFT of your collection. You can change the collection being watched by using the `TARGET_CONTRACT` environment variable.

## Docker

A docker image is provided and available on docker hub. You can override the `.env` environment variables to configure the container. The simplest startup options are shown below:

```
docker run -it -e WORK_DIRECTORY=/app/work/ -v /tmp/work:/app/work -p 3000:3000 phunks-event-scrapper
```

## Things to be implemented

- Better code structure using callbacks, so this could be used for other purposes (like a sale bot)
- Extract specific traits from the tokens into the database and index them.
- Some shamy code needs to be factorized
