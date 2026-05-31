const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const redis = require('redis');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());

// Ensure the 'db' directory exists before SQLite initializes (Crucial for Render)
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)){
    fs.mkdirSync(dbDir);
}

// 1. Initialize SQLite Database
const db = new sqlite3.Database('./db/database.sqlite', (err) => {
    if (err) console.error('SQLite connection error:', err.message);
    else console.log('Connected to SQLite database.');
});

// Create URLs table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    longUrl TEXT NOT NULL,
    shortCode TEXT UNIQUE NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Create Clicks table for analytics tracking
db.run(`
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shortCode TEXT NOT NULL,
    clickedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(shortCode) REFERENCES urls(shortCode)
  )
`);

// 2. Initialize Redis Client
const redisClient = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.connect().then(() => console.log('Connected to Redis Cache.'));


// 3. API Endpoints

// Endpoint to shorten a URL
app.post('/api/shorten', async (req, res) => {
    const { longUrl } = req.body;
    if (!longUrl) {
        return res.status(400).json({ error: 'longUrl is required' });
    }

    // Generate a random 7-character short code
    const crypto = require('crypto');
    const shortCode = crypto.randomBytes(4).toString('hex').slice(0, 7);

    db.run('INSERT INTO urls (longUrl, shortCode) VALUES (?, ?)', [longUrl, shortCode], async function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database insertion error' });
        }

        // Cache the new link in Redis
        await redisClient.set(shortCode, longUrl);

        const baseUrl = process.env.PORT ? `https://${req.get('host')}` : `http://localhost:${PORT}`;
        res.status(201).json({
            shortCode,
            shortUrl: `${baseUrl}/${shortCode}`
        });
    });
});

// Endpoint to fetch analytics metrics for a short code
app.get('/api/analytics/:shortCode', (req, res) => {
    const { shortCode } = req.params;
  
    const urlQuery = `SELECT longUrl, createdAt FROM urls WHERE shortCode = ?`;
    const clickQuery = `SELECT clickedAt FROM clicks WHERE shortCode = ? ORDER BY clickedAt DESC`;
  
    db.get(urlQuery, [shortCode], (err, urlRow) => {
        if (err || !urlRow) {
            return res.status(404).json({ error: 'Short URL tracking data not found' });
        }
  
        db.all(clickQuery, [shortCode], (err, clickRows) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to compile click logs' });
            }
  
            return res.json({
                shortCode,
                longUrl: urlRow.longUrl,
                createdOn: urlRow.createdAt,
                totalClicks: clickRows.length,
                clickHistory: clickRows.map(row => row.clickedAt)
            });
        });
    });
});

// Incoming redirection redirection endpoint (Must be at the bottom)
app.get('/:shortCode', async (req, res) => {
    const { shortCode } = req.params;
  
    try {
        // 1. Try fetching from Redis cache
        const cachedUrl = await redisClient.get(shortCode);
      
        if (cachedUrl) {
            // Asynchronous log to SQLite in background
            db.run('INSERT INTO clicks (shortCode) VALUES (?)', [shortCode]);
            return res.redirect(cachedUrl);
        }
  
        // 2. Fallback to SQLite database
        db.get('SELECT longUrl FROM urls WHERE shortCode = ?', [shortCode], (err, row) => {
            if (err || !row) {
                return res.status(404).send('URL Not Found');
            }
  
            // Log click to SQLite
            db.run('INSERT INTO clicks (shortCode) VALUES (?)', [shortCode]);
  
            // Seed cache for future visitors
            redisClient.set(shortCode, row.longUrl);
  
            return res.redirect(row.longUrl);
        });
  
    } catch (error) {
        console.error('Redirection routing error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start server dynamically based on cloud env environment configuration
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});