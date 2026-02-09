require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

// --- Config ---
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const FINNHUB_REST = 'https://finnhub.io/api/v1';
const ALPHA_VANTAGE_REST = 'https://www.alphavantage.co/query';

// Mega-cap companies for earnings filter
const MEGA_CAPS = [
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA',
  'AVGO', 'JPM', 'V', 'MA', 'UNH', 'HD', 'COST', 'NFLX', 'CRM', 'AMD', 'ADBE', 'LIN'
];

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// REST API ROUTES
// ============================================================

// --- Stock Quote (Finnhub) ---
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const response = await fetch(
      `${FINNHUB_REST}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error });
    res.json({
      symbol: symbol.toUpperCase(),
      price: data.c,
      change: data.d,
      changePercent: data.dp,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
      timestamp: data.t
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// --- Company Profile (Finnhub) ---
app.get('/api/profile/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const response = await fetch(
      `${FINNHUB_REST}/stock/profile2?symbol=${symbol.toUpperCase()}&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// --- Market News (Finnhub) ---
app.get('/api/news/market', async (req, res) => {
  try {
    const response = await fetch(
      `${FINNHUB_REST}/news?category=general&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    const mapped = data.slice(0, 20).map(article => ({
      headline: article.headline,
      source: article.source,
      url: article.url,
      thumbnail: article.image || null,
      timestamp: article.datetime ? new Date(article.datetime * 1000).toISOString() : null,
      summary: article.summary
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch market news' });
  }
});

// --- Company News (Finnhub) ---
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const response = await fetch(
      `${FINNHUB_REST}/company-news?symbol=${symbol.toUpperCase()}&from=${weekAgo}&to=${today}&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    const mapped = data.slice(0, 10).map(article => ({
      headline: article.headline,
      source: article.source,
      url: article.url,
      thumbnail: article.image || null,
      timestamp: article.datetime ? new Date(article.datetime * 1000).toISOString() : null,
      summary: article.summary
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch company news' });
  }
});

// --- Futures Quote (tries multiple symbol formats) ---
app.get('/api/futures/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const sym = symbol.toUpperCase();

    // Finnhub uses different formats for futures — try the symbol as-is first
    // Then try without =F suffix, and with exchange prefix
    const variations = [sym, sym.replace('=F', ''), `CME:${sym.replace('=F', '')}`];

    for (const trySymbol of variations) {
      try {
        const response = await fetch(
          `${FINNHUB_REST}/quote?symbol=${trySymbol}&token=${FINNHUB_KEY}`
        );
        const data = await response.json();
        if (data.c && data.c > 0) {
          return res.json({
            symbol: sym,
            price: data.c,
            change: data.d,
            changePercent: data.dp,
            high: data.h,
            low: data.l,
            open: data.o,
            previousClose: data.pc,
            timestamp: data.t,
            resolvedSymbol: trySymbol
          });
        }
      } catch {}
    }

    // Fallback: try ETF proxies for mini futures
    const proxyMap = {
      'MES=F': 'SPY', 'ES=F': 'SPY',
      'MNQ=F': 'QQQ', 'NQ=F': 'QQQ'
    };
    const proxy = proxyMap[sym];
    if (proxy) {
      const response = await fetch(
        `${FINNHUB_REST}/quote?symbol=${proxy}&token=${FINNHUB_KEY}`
      );
      const data = await response.json();
      return res.json({
        symbol: sym,
        price: data.c,
        change: data.d,
        changePercent: data.dp,
        high: data.h,
        low: data.l,
        open: data.o,
        previousClose: data.pc,
        timestamp: data.t,
        proxy: proxy,
        note: `Using ${proxy} ETF as proxy (free tier limitation)`
      });
    }

    res.json({ symbol: sym, error: 'No data available' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch futures quote' });
  }
});

// --- Market Status (Finnhub) ---
app.get('/api/market-status', async (req, res) => {
  try {
    const response = await fetch(
      `${FINNHUB_REST}/stock/market-status?exchange=US&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    res.json({ status: data.isOpen ? 'open' : 'closed', ...data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch market status' });
  }
});

// --- Intraday Data (Alpha Vantage) ---
app.get('/api/intraday/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = req.query.interval || '5min';
    const response = await fetch(
      `${ALPHA_VANTAGE_REST}?function=TIME_SERIES_INTRADAY&symbol=${symbol.toUpperCase()}&interval=${interval}&apikey=${ALPHA_VANTAGE_KEY}`
    );
    const data = await response.json();
    const timeSeries = data[`Time Series (${interval})`];
    if (!timeSeries) return res.json([]);

    const points = Object.entries(timeSeries).map(([time, values]) => ({
      time,
      open: parseFloat(values['1. open']),
      high: parseFloat(values['2. high']),
      low: parseFloat(values['3. low']),
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume'])
    }));

    res.json(points.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch intraday data' });
  }
});

// --- Search Symbols (Finnhub) ---
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    const response = await fetch(
      `${FINNHUB_REST}/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    );
    const data = await response.json();
    res.json((data.result || []).slice(0, 10));
  } catch (err) {
    res.status(500).json({ error: 'Failed to search symbols' });
  }
});

// --- Index Quotes (batch) ---
app.get('/api/indices', async (req, res) => {
  try {
    const indices = [
      { symbol: 'MES=F', name: 'Micro E-mini S&P (MES)', futures: true },
      { symbol: 'MNQ=F', name: 'Micro E-mini NASDAQ (MNQ)', futures: true },
      { symbol: 'ES=F', name: 'E-mini S&P 500 (ES)', futures: true },
      { symbol: 'NQ=F', name: 'E-mini NASDAQ (NQ)', futures: true },
      { symbol: 'SPY', name: 'S&P 500 (SPY)' },
      { symbol: 'QQQ', name: 'NASDAQ 100 (QQQ)' },
      { symbol: 'DIA', name: 'Dow Jones (DIA)' },
      { symbol: 'IWM', name: 'Russell 2000 (IWM)' },
      { symbol: 'VIX', name: 'VIX Volatility' }
    ];

    const results = await Promise.all(
      indices.map(async (idx) => {
        try {
          const response = await fetch(
            `${FINNHUB_REST}/quote?symbol=${idx.symbol}&token=${FINNHUB_KEY}`
          );
          const data = await response.json();
          return {
            ...idx,
            price: data.c,
            change: data.d,
            changePercent: data.dp,
            high: data.h,
            low: data.l
          };
        } catch {
          return { ...idx, error: true };
        }
      })
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch indices' });
  }
});

// --- Sector Performance (Finnhub) ---
app.get('/api/sectors', async (req, res) => {
  try {
    const sectors = [
      { symbol: 'XLK', name: 'Technology' },
      { symbol: 'XLF', name: 'Financials' },
      { symbol: 'XLV', name: 'Healthcare' },
      { symbol: 'XLE', name: 'Energy' },
      { symbol: 'XLI', name: 'Industrials' },
      { symbol: 'XLC', name: 'Communications' },
      { symbol: 'XLY', name: 'Consumer Discretionary' },
      { symbol: 'XLP', name: 'Consumer Staples' },
      { symbol: 'XLU', name: 'Utilities' },
      { symbol: 'XLRE', name: 'Real Estate' },
      { symbol: 'XLB', name: 'Materials' }
    ];

    const results = await Promise.all(
      sectors.map(async (sector) => {
        try {
          const response = await fetch(
            `${FINNHUB_REST}/quote?symbol=${sector.symbol}&token=${FINNHUB_KEY}`
          );
          const data = await response.json();
          return {
            name: sector.name,
            symbol: sector.symbol,
            price: data.c,
            change: data.d,
            changePercent: data.dp
          };
        } catch {
          return {
            name: sector.name,
            symbol: sector.symbol,
            error: true
          };
        }
      })
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sector performance' });
  }
});

// --- Earnings Calendar (Finnhub) - Filtered to mega-cap companies ---
app.get('/api/earnings', async (req, res) => {
  try {
    const { from, to } = req.query;

    // Validate and use provided dates or default to reasonable range
    let fromDate = from;
    let toDate = to;

    if (!fromDate || !toDate) {
      const today = new Date();
      const endDate = new Date(today.getTime() + 90 * 86400000); // 90 days out
      fromDate = fromDate || today.toISOString().split('T')[0];
      toDate = toDate || endDate.toISOString().split('T')[0];
    }

    const response = await fetch(
      `${FINNHUB_REST}/calendar/earnings?from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
    );
    const data = await response.json();

    if (!data.earningsCalendar) {
      return res.json([]);
    }

    // Filter to only mega-cap companies
    const results = data.earningsCalendar
      .filter((earning) => MEGA_CAPS.includes(earning.symbol.toUpperCase()))
      .map((earning) => ({
        symbol: earning.symbol,
        name: earning.name,
        date: earning.date,
        epsEstimate: earning.epsEstimate ? String(earning.epsEstimate) : null,
        epsActual: earning.epsActual ? String(earning.epsActual) : null,
        time: earning.hour === 'bmo' ? 'bmo' : 'amc',
        quarter: earning.quarter,
        year: earning.year
      }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings calendar' });
  }
});

// --- Technical Indicators (Alpha Vantage) ---
app.get('/api/indicator/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { indicator } = req.query;

    if (!indicator) {
      return res.status(400).json({ error: 'indicator query param required (sma, ema, rsi)' });
    }

    const validIndicators = ['sma', 'ema', 'rsi'];
    if (!validIndicators.includes(indicator.toLowerCase())) {
      return res.status(400).json({ error: 'indicator must be sma, ema, or rsi' });
    }

    const sym = symbol.toUpperCase();
    const ind = indicator.toLowerCase();

    let functionName = '';
    let timePeriod = 20;
    let seriesType = 'close';

    if (ind === 'sma') {
      functionName = 'SMA';
      timePeriod = 20;
    } else if (ind === 'ema') {
      functionName = 'EMA';
      timePeriod = 20;
    } else if (ind === 'rsi') {
      functionName = 'RSI';
      timePeriod = 14;
    }

    const response = await fetch(
      `${ALPHA_VANTAGE_REST}?function=${functionName}&symbol=${sym}&time_period=${timePeriod}&series_type=${seriesType}&apikey=${ALPHA_VANTAGE_KEY}`
    );
    const data = await response.json();

    // Extract the technical indicator data
    let indicatorKey = '';
    if (ind === 'sma') {
      indicatorKey = 'Technical Analysis: SMA';
    } else if (ind === 'ema') {
      indicatorKey = 'Technical Analysis: EMA';
    } else if (ind === 'rsi') {
      indicatorKey = 'Technical Analysis: RSI';
    }

    const indicatorData = data[indicatorKey] || {};

    const results = Object.entries(indicatorData).map(([date, values]) => ({
      date,
      value: parseFloat(values[ind.toUpperCase()])
    }));

    res.json({
      symbol: sym,
      indicator: ind,
      timePeriod: timePeriod,
      data: results.slice(0, 100) // Return last 100 data points
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch technical indicator' });
  }
});

// --- Economic Calendar (Finnhub) ---
app.get('/api/economic-calendar', async (req, res) => {
  try {
    const response = await fetch(
      `${FINNHUB_REST}/calendar/economic?token=${FINNHUB_KEY}`
    );
    const data = await response.json();

    if (!data || !Array.isArray(data)) {
      return res.json([]);
    }

    // Filter to USD events and map fields
    const filtered = data
      .filter((event) => event.country === 'US')
      .map((event) => ({
        date: event.date,
        event: event.event,
        country: event.country,
        impact: event.impact,
        actual: event.actual || null,
        estimate: event.estimate || null,
        previous: event.previous || null,
        unit: event.unit || ''
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 50);

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch economic calendar' });
  }
});

// --- Fed Events ---
app.get('/api/fed-events', async (req, res) => {
  try {
    // Hardcoded Fed/FOMC schedule for 2025-2026
    const hardcodedFedEvents = [
      {
        date: '2025-01-29',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-02-10',
        name: 'Federal Reserve Chair Powell Speech',
        type: 'speech',
        importance: 'high'
      },
      {
        date: '2025-03-18',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-03-21',
        name: 'FOMC Minutes Release',
        type: 'minutes',
        importance: 'medium'
      },
      {
        date: '2025-04-15',
        name: 'Federal Reserve Vice Chair Speech',
        type: 'speech',
        importance: 'medium'
      },
      {
        date: '2025-05-06',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-06-17',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-07-16',
        name: 'FOMC Minutes Release',
        type: 'minutes',
        importance: 'medium'
      },
      {
        date: '2025-07-29',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-09-16',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-10-15',
        name: 'Federal Reserve Chair Powell Speech',
        type: 'speech',
        importance: 'high'
      },
      {
        date: '2025-11-05',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2025-12-16',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2026-01-27',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2026-03-17',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2026-05-05',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      },
      {
        date: '2026-06-16',
        name: 'FOMC Meeting Decision',
        type: 'rate_decision',
        importance: 'high'
      }
    ];

    // Try to fetch from Finnhub and filter for Fed-related events
    let finnhubEvents = [];
    try {
      const response = await fetch(
        `${FINNHUB_REST}/calendar/economic?token=${FINNHUB_KEY}`
      );
      const data = await response.json();

      if (Array.isArray(data)) {
        finnhubEvents = data
          .filter((event) => {
            const eventName = (event.event || "").toLowerCase();
            return (
              eventName.includes("fed") ||
              eventName.includes("fomc") ||
              eventName.includes("interest rate") ||
              eventName.includes("federal")
            );
          })
          .map((event) => {
            const eventName = (event.event || "").toLowerCase();
            return {
              date: event.date,
              name: event.event,
              type: eventName.includes("rate") ? "rate_decision" : "speech",
              importance: event.impact === "high" ? "high" : "medium"
            };
          });
      }
    } catch {}

    const combined = [...hardcodedFedEvents];
    const existingDates = new Set(hardcodedFedEvents.map((e) => e.date));

    finnhubEvents.forEach((event) => {
      if (!existingDates.has(event.date)) {
        combined.push(event);
      }
    });

    // Sort by date
    combined.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json(combined);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Fed events' });
  }
});

// --- Forex News (USD high-impact events) ---
app.get('/api/forex-news', async (req, res) => {
  try {
    const response = await fetch(
      `${FINNHUB_REST}/calendar/economic?token=${FINNHUB_KEY}`
    );
    const data = await response.json();

    if (!Array.isArray(data)) {
      return res.json([]);
    }

    // Helper function to categorize events
    const getCategoryFromEvent = (eventName) => {
      const name = (eventName || '').toLowerCase();

      if (name.includes('non-farm') || name.includes('nfp') || name.includes('unemployment')) {
        return 'Employment';
      }
      if (name.includes('cpi') || name.includes('ppi') || name.includes('inflation')) {
        return 'Inflation';
      }
      if (name.includes('gdp')) {
        return 'Growth';
      }
      if (name.includes('fomc') || name.includes('fed') || name.includes('interest rate') || name.includes('federal')) {
        return 'Fed';
      }
      if (name.includes('retail') || name.includes('consumer') || name.includes('sales')) {
        return 'Consumer';
      }
      if (name.includes('housing') || name.includes('starts') || name.includes('building')) {
        return 'Housing';
      }
      if (name.includes('jobless') || name.includes('claims')) {
        return 'Employment';
      }

      return 'Economic';
    };

    // Filter to US high-impact events
    const filtered = data
      .filter((event) => event.country === 'US' && event.impact === 'high')
      .map((event) => ({
        date: event.date,
        event: event.event,
        country: event.country,
        impact: event.impact,
        actual: event.actual || null,
        forecast: event.estimate || null,
        previous: event.previous || null,
        unit: event.unit || '',
        category: getCategoryFromEvent(event.event)
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch forex news' });
  }
});

// --- Market Movers (Top Gainers/Losers) ---
app.get('/api/market-movers', async (req, res) => {
  try {
    const symbols = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'NFLX', 'CRM',
      'INTC', 'PYPL', 'COIN', 'UBER', 'ABNB', 'PLTR', 'SNAP', 'ROKU', 'SQ', 'SHOP'
    ];

    const quotes = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const response = await fetch(
            `${FINNHUB_REST}/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
          );
          const data = await response.json();

          if (data.c && data.c > 0) {
            return {
              symbol,
              price: data.c,
              change: data.d,
              changePercent: data.dp,
              high: data.h,
              low: data.l,
              open: data.o,
              previousClose: data.pc,
              timestamp: data.t
            };
          }
        } catch {}

        return null;
      })
    );

    // Filter out failed requests
    const validQuotes = quotes.filter((q) => q !== null);

    // Sort by percentChange
    validQuotes.sort((a, b) => b.changePercent - a.changePercent);

    // Get top 5 gainers and top 5 losers
    const gainers = validQuotes.slice(0, 5);
    const losers = validQuotes.slice(-5).reverse();

    res.json({
      gainers,
      losers
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch market movers' });
  }
});

// --- Global Indices (using ETF proxies) ---
app.get('/api/global-indices', async (req, res) => {
  try {
    const indices = [
      { symbol: 'EWU', name: 'FTSE 100 (UK)', region: 'London' },
      { symbol: 'EWJ', name: 'Nikkei 225 (Japan)', region: 'Tokyo' },
      { symbol: 'FXI', name: 'Hang Seng (HK)', region: 'Hong Kong' },
      { symbol: 'MCHI', name: 'Shanghai (China)', region: 'Shanghai' },
      { symbol: 'EWG', name: 'DAX (Germany)', region: 'Frankfurt' },
      { symbol: 'EFA', name: 'Intl Developed', region: 'Global' }
    ];

    const results = await Promise.all(
      indices.map(async (idx) => {
        try {
          const response = await fetch(
            `${FINNHUB_REST}/quote?symbol=${idx.symbol}&token=${FINNHUB_KEY}`
          );
          const data = await response.json();
          return {
            symbol: idx.symbol,
            name: idx.name,
            region: idx.region,
            price: data.c,
            change: data.d,
            changePercent: data.dp
          };
        } catch {
          return {
            symbol: idx.symbol,
            name: idx.name,
            region: idx.region,
            error: true
          };
        }
      })
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch global indices' });
  }
});

// --- Commodities ---
app.get('/api/commodities', async (req, res) => {
  try {
    const commodities = [
      { symbol: 'GLD', name: 'Gold', unit: 'oz' },
      { symbol: 'USO', name: 'Crude Oil', unit: 'bbl' },
      { symbol: 'UNG', name: 'Natural Gas', unit: 'mmBtu' },
      { symbol: 'SLV', name: 'Silver', unit: 'oz' }
    ];

    const results = await Promise.all(
      commodities.map(async (commodity) => {
        try {
          const response = await fetch(
            `${FINNHUB_REST}/quote?symbol=${commodity.symbol}&token=${FINNHUB_KEY}`
          );
          const data = await response.json();
          return {
            symbol: commodity.symbol,
            name: commodity.name,
            unit: commodity.unit,
            price: data.c,
            change: data.d,
            changePercent: data.dp
          };
        } catch {
          return {
            symbol: commodity.symbol,
            name: commodity.name,
            unit: commodity.unit,
            error: true
          };
        }
      })
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch commodities' });
  }
});


// --- Fear & Greed Index ---
app.get('/api/fear-greed', async (req, res) => {
  try {
    // Fetch VIX and SPY quotes
    const vixResponse = await fetch(
      `${FINNHUB_REST}/quote?symbol=VIX&token=${FINNHUB_KEY}`
    );
    const vixData = await vixResponse.json();

    const spyResponse = await fetch(
      `${FINNHUB_REST}/quote?symbol=SPY&token=${FINNHUB_KEY}`
    );
    const spyData = await spyResponse.json();

    const vixPrice = vixData.c || 0;
    const spyChangePercent = spyData.dp || 0;

    // Calculate sentiment based on VIX level
    let sentiment = '';
    let sentimentScore = 50; // Start at neutral

    if (vixPrice < 12) {
      sentiment = 'Extreme Greed';
      sentimentScore = 95;
    } else if (vixPrice < 17) {
      sentiment = 'Greed';
      sentimentScore = 75;
    } else if (vixPrice < 22) {
      sentiment = 'Neutral';
      sentimentScore = 50;
    } else if (vixPrice < 30) {
      sentiment = 'Fear';
      sentimentScore = 25;
    } else {
      sentiment = 'Extreme Fear';
      sentimentScore = 5;
    }

    const spyDirection = spyChangePercent >= 0 ? 'Bullish' : 'Bearish';

    let description = '';
    if (sentiment === 'Extreme Greed') {
      description = 'Market showing signs of extreme euphoria. Consider taking profits.';
    } else if (sentiment === 'Greed') {
      description = 'Strong market confidence. Positive momentum visible.';
    } else if (sentiment === 'Neutral') {
      description = 'Market in balance. No clear directional bias.';
    } else if (sentiment === 'Fear') {
      description = 'Market volatility elevated. Investors showing caution.';
    } else {
      description = 'Market in extreme panic. Potential buying opportunity for long-term investors.';
    }

    res.json({
      vix: {
        price: vixPrice,
        change: vixData.d || 0,
        changePercent: vixData.dp || 0
      },
      sentiment,
      sentimentScore,
      spyDirection,
      description
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fear/greed index' });
  }
});

// --- Daily Market Briefing (Comprehensive Sentiment Analysis) ---
app.get('/api/daily-briefing', async (req, res) => {
  try {
    // Parallel fetch all data sources
    const [vixRes, spyRes, qqqRes, globalRes, goldRes, oilRes, calendarRes, earningsRes, newsRes] = await Promise.all([
      fetch(`${FINNHUB_REST}/quote?symbol=VIX&token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/quote?symbol=SPY&token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/quote?symbol=QQQ&token=${FINNHUB_KEY}`),
      Promise.all([
        fetch(`${FINNHUB_REST}/quote?symbol=EWU&token=${FINNHUB_KEY}`).then(r => r.json()).catch(() => ({})),
        fetch(`${FINNHUB_REST}/quote?symbol=EWJ&token=${FINNHUB_KEY}`).then(r => r.json()).catch(() => ({})),
        fetch(`${FINNHUB_REST}/quote?symbol=FXI&token=${FINNHUB_KEY}`).then(r => r.json()).catch(() => ({})),
        fetch(`${FINNHUB_REST}/quote?symbol=EWG&token=${FINNHUB_KEY}`).then(r => r.json()).catch(() => ({})),
      ]),
      fetch(`${FINNHUB_REST}/quote?symbol=GLD&token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/quote?symbol=USO&token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/calendar/economic?token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/calendar/earnings?from=${new Date().toISOString().split('T')[0]}&to=${new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]}&token=${FINNHUB_KEY}`),
      fetch(`${FINNHUB_REST}/news?category=general&token=${FINNHUB_KEY}`)
    ]);

    const [vixData, spyData, qqqData] = await Promise.all([vixRes.json(), spyRes.json(), qqqRes.json()]);
    const [londonData, tokyoData, hongkongData, frankfurtData] = globalRes;
    const [goldData, oilData, calendarData, earningsData, newsData] = await Promise.all([goldRes.json(), oilRes.json(), calendarRes.json(), earningsRes.json(), newsRes.json()]);

    const vixPrice = vixData.c || 0;
    const spyChange = spyData.dp || 0;
    const qqqChange = qqqData.dp || 0;
    const spyPrice = spyData.c || 0;
    const qqqPrice = qqqData.c || 0;
    const goldChange = goldData.dp || 0;
    const oilChange = oilData.dp || 0;

    // === SCORING ENGINE ===
    let score = 50;
    const factors = [];
    const analysis = [];

    // 1. VIX Analysis (weight: 25)
    if (vixPrice < 14) {
      score += 20;
      factors.push({ factor: 'VIX Extremely Low', detail: `VIX at ${vixPrice.toFixed(1)} — very low volatility, strong risk appetite`, points: 20 });
      analysis.push(`VIX at ${vixPrice.toFixed(1)} signals extremely low volatility — strong risk-on environment favoring long MES/MNQ positions.`);
    } else if (vixPrice < 18) {
      score += 12;
      factors.push({ factor: 'VIX Low', detail: `VIX at ${vixPrice.toFixed(1)} — below average volatility`, points: 12 });
      analysis.push(`VIX at ${vixPrice.toFixed(1)} shows below-average volatility — constructive for bullish positioning.`);
    } else if (vixPrice < 22) {
      factors.push({ factor: 'VIX Normal', detail: `VIX at ${vixPrice.toFixed(1)} — average range`, points: 0 });
      analysis.push(`VIX at ${vixPrice.toFixed(1)} sitting in the normal range — no strong volatility signal.`);
    } else if (vixPrice < 30) {
      score -= 15;
      factors.push({ factor: 'VIX Elevated', detail: `VIX at ${vixPrice.toFixed(1)} — elevated fear`, points: -15 });
      analysis.push(`VIX at ${vixPrice.toFixed(1)} is elevated, signaling increased fear — consider caution on long MES/MNQ entries.`);
    } else {
      score -= 25;
      factors.push({ factor: 'VIX Spiking', detail: `VIX at ${vixPrice.toFixed(1)} — extreme fear/panic`, points: -25 });
      analysis.push(`VIX at ${vixPrice.toFixed(1)} is in panic territory — high probability of continued selling pressure on MES/MNQ.`);
    }

    // 2. SPY/QQQ Momentum (weight: 20)
    const avgMomentum = (spyChange + qqqChange) / 2;
    if (avgMomentum > 1) {
      score += 18;
      factors.push({ factor: 'Strong Bullish Momentum', detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}%, QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%`, points: 18 });
      analysis.push(`SPY (${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}%) and QQQ (${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%) showing strong upward momentum — MES/MNQ likely to follow.`);
    } else if (avgMomentum > 0.2) {
      score += 10;
      factors.push({ factor: 'Mild Bullish Momentum', detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}%, QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%`, points: 10 });
      analysis.push(`SPY (${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}%) and QQQ (${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%) tilting positive — mild bullish bias for MES/MNQ.`);
    } else if (avgMomentum > -0.2) {
      factors.push({ factor: 'Flat Momentum', detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}%, QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%`, points: 0 });
      analysis.push(`SPY and QQQ are essentially flat — no clear directional bias from US index momentum.`);
    } else if (avgMomentum > -1) {
      score -= 10;
      factors.push({ factor: 'Mild Bearish Momentum', detail: `SPY ${spyChange.toFixed(2)}%, QQQ ${qqqChange.toFixed(2)}%`, points: -10 });
      analysis.push(`SPY (${spyChange.toFixed(2)}%) and QQQ (${qqqChange.toFixed(2)}%) tilting negative — cautious stance on MES/MNQ longs.`);
    } else {
      score -= 18;
      factors.push({ factor: 'Strong Bearish Momentum', detail: `SPY ${spyChange.toFixed(2)}%, QQQ ${qqqChange.toFixed(2)}%`, points: -18 });
      analysis.push(`SPY (${spyChange.toFixed(2)}%) and QQQ (${qqqChange.toFixed(2)}%) in selloff mode — MES/MNQ likely to see continued selling pressure.`);
    }

    // 3. Global Markets Analysis (weight: 15)
    const globalChanges = [londonData.dp || 0, tokyoData.dp || 0, hongkongData.dp || 0, frankfurtData.dp || 0];
    const globalAvg = globalChanges.reduce((a, b) => a + b, 0) / globalChanges.length;
    const positiveGlobal = globalChanges.filter(g => g > 0).length;
    const globalNames = ['London (FTSE)', 'Tokyo (Nikkei)', 'Hong Kong (HSI)', 'Frankfurt (DAX)'];
    const globalSummary = globalNames.map((name, i) => `${name}: ${globalChanges[i] >= 0 ? '+' : ''}${globalChanges[i].toFixed(2)}%`).join(', ');

    if (globalAvg > 0.5) {
      score += 10;
      factors.push({ factor: 'Global Markets Bullish', detail: globalSummary, points: 10 });
    } else if (globalAvg > 0) {
      score += 5;
      factors.push({ factor: 'Global Markets Mixed-Positive', detail: globalSummary, points: 5 });
    } else if (globalAvg > -0.5) {
      score -= 5;
      factors.push({ factor: 'Global Markets Mixed-Negative', detail: globalSummary, points: -5 });
    } else {
      score -= 10;
      factors.push({ factor: 'Global Markets Bearish', detail: globalSummary, points: -10 });
    }
    analysis.push(`Global markets: ${positiveGlobal} of 4 major regions positive. ${globalSummary}. ${globalAvg > 0 ? 'Positive overnight tone supports MES/MNQ.' : 'Negative global sentiment may weigh on US futures.'}`);

    // 4. Commodities (weight: 8)
    if (goldChange > 1) {
      score -= 5;
      factors.push({ factor: 'Gold Rising (Risk-Off)', detail: `Gold ${goldChange > 0 ? '+' : ''}${goldChange.toFixed(2)}%`, points: -5 });
      analysis.push(`Gold up ${goldChange.toFixed(2)}% — flight to safety suggests some risk-off sentiment.`);
    } else if (goldChange < -0.5) {
      score += 3;
      factors.push({ factor: 'Gold Falling (Risk-On)', detail: `Gold ${goldChange.toFixed(2)}%`, points: 3 });
      analysis.push(`Gold down ${goldChange.toFixed(2)}% — risk-on rotation supports equity longs.`);
    }

    if (oilChange > 2) {
      score -= 3;
      factors.push({ factor: 'Oil Spiking', detail: `Oil ${oilChange > 0 ? '+' : ''}${oilChange.toFixed(2)}%`, points: -3 });
      analysis.push(`Oil spiking ${oilChange.toFixed(2)}% — energy cost concerns may pressure broader market.`);
    } else if (oilChange < -2) {
      score -= 2;
      factors.push({ factor: 'Oil Selling Off', detail: `Oil ${oilChange.toFixed(2)}%`, points: -2 });
      analysis.push(`Oil down sharply (${oilChange.toFixed(2)}%) — could signal demand concerns.`);
    }

    // 5. Economic Calendar Today (weight: 12)
    let todaysEvents = [];
    const today = new Date().toISOString().split('T')[0];
    if (Array.isArray(calendarData)) {
      todaysEvents = calendarData.filter(e => e.country === 'US' && e.date === today);
    }
    const highImpactToday = todaysEvents.filter(e => e.impact === 'high');

    if (highImpactToday.length > 0) {
      const eventNames = highImpactToday.map(e => e.event).join(', ');
      score -= 5 * Math.min(highImpactToday.length, 3);
      factors.push({ factor: `${highImpactToday.length} High-Impact Event(s) Today`, detail: eventNames, points: -5 * Math.min(highImpactToday.length, 3) });
      analysis.push(`Heads up: ${highImpactToday.length} high-impact release(s) today — ${eventNames}. Expect elevated volatility around data prints. Consider tightening stops on MES/MNQ positions.`);
    } else {
      score += 3;
      factors.push({ factor: 'No Major Data Today', detail: 'Light economic calendar', points: 3 });
      analysis.push(`Clean economic calendar today — no high-impact data releases. This typically means lower intraday volatility and more predictable price action on MES/MNQ.`);
    }

    // 6. Mega-Cap Earnings (weight: 10)
    let upcomingEarnings = [];
    if (earningsData && earningsData.earningsCalendar) {
      upcomingEarnings = earningsData.earningsCalendar
        .filter(e => MEGA_CAPS.includes((e.symbol || '').toUpperCase()))
        .slice(0, 5);
    }

    if (upcomingEarnings.length > 0) {
      const earningsList = upcomingEarnings.map(e => `${e.symbol} (${e.date})`).join(', ');
      const todayEarnings = upcomingEarnings.filter(e => e.date === today);
      if (todayEarnings.length > 0) {
        score -= 5;
        factors.push({ factor: 'Mega-Cap Earnings Today', detail: earningsList, points: -5 });
        analysis.push(`Major earnings today: ${todayEarnings.map(e => e.symbol).join(', ')}. NQ/MNQ could see significant moves post-report. Consider reducing position size ahead of the release.`);
      } else {
        factors.push({ factor: 'Mega-Cap Earnings This Week', detail: earningsList, points: 0 });
        analysis.push(`Upcoming mega-cap earnings this week: ${earningsList}. Keep on radar for potential NQ/MNQ volatility.`);
      }
    }

    // 7. News Sentiment (basic headline scan)
    let bearishNewsCount = 0;
    let bullishNewsCount = 0;
    const bearishKeywords = ['crash', 'recession', 'plunge', 'selloff', 'sell-off', 'crisis', 'fear', 'downgrade', 'layoffs', 'warning', 'risk', 'tariff', 'war'];
    const bullishKeywords = ['rally', 'surge', 'record', 'breakout', 'upgrade', 'growth', 'boom', 'beat', 'strong', 'hire', 'bullish'];

    if (Array.isArray(newsData)) {
      newsData.slice(0, 20).forEach(article => {
        const text = ((article.headline || '') + ' ' + (article.summary || '')).toLowerCase();
        bearishKeywords.forEach(kw => { if (text.includes(kw)) bearishNewsCount++; });
        bullishKeywords.forEach(kw => { if (text.includes(kw)) bullishNewsCount++; });
      });
    }

    if (bullishNewsCount > bearishNewsCount + 3) {
      score += 5;
      factors.push({ factor: 'Positive News Flow', detail: `${bullishNewsCount} bullish vs ${bearishNewsCount} bearish signals`, points: 5 });
      analysis.push(`News sentiment is leaning bullish with ${bullishNewsCount} positive signals vs ${bearishNewsCount} negative.`);
    } else if (bearishNewsCount > bullishNewsCount + 3) {
      score -= 5;
      factors.push({ factor: 'Negative News Flow', detail: `${bearishNewsCount} bearish vs ${bullishNewsCount} bullish signals`, points: -5 });
      analysis.push(`News flow is bearish-tilted with ${bearishNewsCount} negative signals vs ${bullishNewsCount} positive — sentiment headwind for longs.`);
    }

    // === FINAL SCORE ===
    score = Math.max(0, Math.min(100, score));

    let signal = '';
    if (score >= 75) signal = 'Strong Bull';
    else if (score >= 60) signal = 'Bull';
    else if (score >= 45) signal = 'Neutral';
    else if (score >= 30) signal = 'Bear';
    else signal = 'Strong Bear';

    // Build the briefing paragraph
    const briefing = analysis.join(' ');

    res.json({
      score: Math.round(score),
      signal,
      briefing,
      factors,
      timestamp: new Date().toISOString(),
      data: {
        vix: { price: vixPrice, change: vixData.d || 0, changePercent: vixData.dp || 0 },
        spy: { price: spyPrice, change: spyData.d || 0, changePercent: spyChange },
        qqq: { price: qqqPrice, change: qqqData.d || 0, changePercent: qqqChange },
        gold: { price: goldData.c || 0, changePercent: goldChange },
        oil: { price: oilData.c || 0, changePercent: oilChange },
        global: {
          london: { changePercent: londonData.dp || 0 },
          tokyo: { changePercent: tokyoData.dp || 0 },
          hongkong: { changePercent: hongkongData.dp || 0 },
          frankfurt: { changePercent: frankfurtData.dp || 0 }
        },
        todaysEvents: highImpactToday.map(e => ({ event: e.event, impact: e.impact })),
        upcomingEarnings: upcomingEarnings.map(e => ({ symbol: e.symbol, date: e.date }))
      }
    });
  } catch (err) {
    console.error('Daily briefing error:', err);
    res.status(500).json({ error: 'Failed to generate daily briefing' });
  }
});

// ============================================================
// WEBSOCKET SERVER — Proxies Finnhub real-time trades
// ============================================================
const wss = new WebSocket.Server({ server, path: '/ws' });

let finnhubWs = null;
let subscribedSymbols = new Set();
let clientCount = 0;

function connectFinnhub() {
  if (finnhubWs && finnhubWs.readyState === WebSocket.OPEN) return;

  finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  finnhubWs.on('open', () => {
    console.log('[Finnhub WS] Connected');
    // Re-subscribe existing symbols
    subscribedSymbols.forEach((sym) => {
      finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    });
  });

  finnhubWs.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'trade' && msg.data) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(msg));
        }
      });
    }
  });

  finnhubWs.on('close', () => {
    console.log('[Finnhub WS] Disconnected — reconnecting in 5s');
    setTimeout(connectFinnhub, 5000);
  });

  finnhubWs.on('error', (err) => {
    console.error('[Finnhub WS] Error:', err.message);
  });
}

wss.on('connection', (clientWs) => {
  clientCount++;
  console.log(`[WS] Client connected (total: ${clientCount})`);

  if (!finnhubWs || finnhubWs.readyState !== WebSocket.OPEN) {
    connectFinnhub();
  }

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.symbol) {
        const sym = msg.symbol.toUpperCase();
        if (!subscribedSymbols.has(sym)) {
          subscribedSymbols.add(sym);
          if (finnhubWs && finnhubWs.readyState === WebSocket.OPEN) {
            finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
          }
        }
      }
      if (msg.type === 'unsubscribe' && msg.symbol) {
        const sym = msg.symbol.toUpperCase();
        subscribedSymbols.delete(sym);
        if (finnhubWs && finnhubWs.readyState === WebSocket.OPEN) {
          finnhubWs.send(JSON.stringify({ type: 'unsubscribe', symbol: sym }));
        }
      }
    } catch (e) {}
  });

  clientWs.on('close', () => {
    clientCount--;
    console.log(`[WS] Client disconnected (total: ${clientCount})`);
    if (clientCount === 0 && finnhubWs) {
      finnhubWs.close();
      finnhubWs = null;
      subscribedSymbols.clear();
    }
  });
});

// ============================================================
// START
// ============================================================
server.listen(PORT, () => {
  console.log(`Stock Dashboard running on http://localhost:${PORT}`);
});
