/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
const Database = require('better-sqlite3');

const db = new Database(`${process.env.WORK_DIRECTORY || './'}db.db`, { verbose: console.log });

app.use(express.json());
app.use('/', express.static('public'));
app.use('/app', express.static('public'));
app.get('/api/token/:tokenId/history', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select *
    from events
    where token_id = ${req.params.tokenId}
    order by tx_date desc
    `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});
app.get('/api/latest', (req, res) => {
  const stmt = db.prepare(`select *
    from events
    order by tx_date desc
    limit 1
    `);
  res.status(200).json(stmt.get());
});
app.get('/api/datas', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select 
        date(tx_date) date, 
        sum(amount/1000000000000000000.0) volume, 
        avg(amount/1000000000000000000.0) average_price, 
        (select avg(amount/1000000000000000000.0) from (select * from events
          where event_type == 'sale'
          and date(tx_date) = date(ev.tx_date)
          order by amount 
          limit 10)) floor_price,
        count(*) sales
    from events ev
    where event_type == 'sale'
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
