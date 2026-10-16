const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const databaseUrl = process.env.DATABASE_URL;
const isLocalDb = !databaseUrl || /localhost|127\.0\.0\.1|::1/.test(databaseUrl);
const ssl = isLocalDb ? false : {
  rejectUnauthorized: true,
  ...(process.env.PGSSLROOTCERT ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') } : {})
};
const pool = new Pool({ connectionString: databaseUrl, ssl });

/* In-memory per-process rate limit. Use a shared limiter (e.g. Redis) for multi-instance deployment. */
const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
const processCandleRateLimit = rateLimit({ windowMs: 60_000, max: 30 });

function requirePaperToken(req, res, next) {
  const expected = process.env.PAPER_API_TOKEN;
  if (!expected || expected.length < 32) {
    return res.status(503).json({ error: 'Paper API authentication is not configured' });
  }
  const header = req.get('authorization') || '';
  if (header !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, mode: 'paper', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, mode: 'paper', database: 'disconnected' });
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    res.json((await pool.query('SELECT reference_capital,risk_fraction,daily_loss_fraction,timeframe FROM bot_settings WHERE id=1')).rows[0] || {});
  } catch {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM signals ORDER BY candle_time DESC LIMIT $1', [Math.min(500, Math.max(1, Number(req.query.limit) || 100))])).rows);
  } catch {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM paper_trades ORDER BY entry_time DESC LIMIT $1', [Math.min(1000, Math.max(1, Number(req.query.limit) || 200))])).rows);
  } catch {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.post('/api/paper/process-candle', requirePaperToken, processCandleRateLimit, async (req, res) => {
  const b = req.body || {};
  const p = Number(b.price), hi = Number(b.high), lo = Number(b.low), a = Number(b.atr);
  const candleMs = typeof b.candleTime === 'string' || typeof b.candleTime === 'number' ? Date.parse(b.candleTime) : NaN;
  const now = Date.now();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(candleMs) || candleMs < now - maxAgeMs || candleMs > now + 60_000 ||
      !['LONG', 'SHORT', 'SIN SEÑAL'].includes(b.signalType) ||
      ![p, hi, lo, a].every(Number.isFinite) || p <= 0 || hi < lo || a <= 0 ||
      (b.rsi != null && (!Number.isFinite(Number(b.rsi)) || Number(b.rsi) < 0 || Number(b.rsi) > 100)) ||
      (b.ema20 != null && (!Number.isFinite(Number(b.ema20)) || Number(b.ema20) <= 0)) ||
      (b.ema50 != null && (!Number.isFinite(Number(b.ema50)) || Number(b.ema50) <= 0))) {
    return res.status(400).json({ error: 'Invalid candle or candleTime outside allowed window' });
  }

  const candleTime = new Date(candleMs).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO signals(candle_time,signal_type,btc_price,rsi,ema20,ema50,atr) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(candle_time) DO NOTHING RETURNING id',
      [candleTime, b.signalType, p, b.rsi ?? null, b.ema20 ?? null, b.ema50 ?? null, a]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return res.json({ duplicate: true });
    }

    const open = (await client.query("SELECT * FROM paper_trades WHERE status='OPEN' FOR UPDATE")).rows[0];
    let closed = null, opened = null;
    if (open) {
      const stopHit = open.side === 'LONG' ? lo <= Number(open.stop_price) : hi >= Number(open.stop_price);
      const targetHit = open.side === 'LONG' ? hi >= Number(open.target_price) : lo <= Number(open.target_price);
      let exit = null, reason = '';
      if (stopHit) { exit = Number(open.stop_price); reason = 'STOP LOSS'; }
      else if (targetHit) { exit = Number(open.target_price); reason = 'TAKE PROFIT'; }
      else if ((open.side === 'LONG' && b.signalType === 'SHORT') || (open.side === 'SHORT' && b.signalType === 'LONG')) {
        exit = p; reason = 'SEÑAL CONTRARIA';
      }
      if (exit !== null) {
        const pnl = Number(open.quantity) * (open.side === 'LONG' ? exit - Number(open.entry_price) : Number(open.entry_price) - exit);
        closed = (await client.query(
          "UPDATE paper_trades SET status='CLOSED',exit_time=$1,exit_price=$2,pnl_usd=$3,exit_reason=$4 WHERE id=$5 RETURNING *",
          [candleTime, exit, pnl, reason, open.id]
        )).rows[0];
      }
    }

    const stillOpen = (await client.query("SELECT id FROM paper_trades WHERE status='OPEN'")).rowCount;
    if (!stillOpen && ['LONG', 'SHORT'].includes(b.signalType)) {
      const settings = (await client.query('SELECT * FROM bot_settings WHERE id=1')).rows[0];
      const risk = Number(settings.reference_capital) * Number(settings.risk_fraction);
      const distance = 1.5 * a;
      const today = Number((await client.query("SELECT COALESCE(SUM(pnl_usd),0) AS pnl FROM paper_trades WHERE status='CLOSED' AND exit_time::date=CURRENT_DATE")).rows[0].pnl);
      const dailyLossLimit = Number(settings.reference_capital) * Number(settings.daily_loss_fraction);
      if (today > -dailyLossLimit) {
        const side = b.signalType;
        const quantity = risk / distance;
        const stop = p + (side === 'LONG' ? -distance : distance);
        const target = p + (side === 'LONG' ? 3 * a : -3 * a);
        opened = (await client.query(
          'INSERT INTO paper_trades(side,entry_time,entry_price,quantity,stop_price,target_price) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [side, candleTime, p, quantity, stop, target]
        )).rows[0];
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, opened, closed });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not process candle' });
  } finally {
    client.release();
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(Number(process.env.PORT || 3000), () => console.log('BTC portal review server ready'));
