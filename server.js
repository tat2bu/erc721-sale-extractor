/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
const Database = require('better-sqlite3');

const db = new Database('db.db', { verbose: console.log });

app.use(express.json());
app.use('/app', express.static('public'));
app.get('/api/datas', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select 
        date(tx_date) date, 
        sum(amount/1000000000000000000.0) volume, 
        avg(amount/1000000000000000000.0) average_price, 
        min(amount/1000000000000000000.0) floor_price, 
        count(*) sales
    from sales
    /* where tokenId in (8553,2708,3609,117,2329,9955,987,9997,4472,1190,5299,1119,5253,6491,1748,2681,8957,7458,2484,8780,5234,1935,6275,9909,8857,4513,3393) */
    group by date(tx_date)
    order by date(tx_date)
    `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
