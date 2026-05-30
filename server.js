require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const redis = require('redis');
const { nanoid } = require('nanoid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

const fs = require('fs');
const path = require('path');

// Ensure the 'db' directory exists before SQLite initializes
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)){
    fs.mkdirSync(dbDir);
}

// Middleware
app.use(cors());
app.use(express.json());

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

// 2. Initialize Redis Client
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.connect().then(() => console.log('Connected to Redis Cache.'));

// 3. API Endpoints

// Endpoint to shorten a URL
app.post('/api/shorten', async (req, res) => {
    const { longUrl } = req.body;
    if (!longUrl) return res.status(400).json({ error: 'URL is required' });

    const shortCode = nanoid(7); // Generates a unique 7-character string

    // Save to SQLite
    const stmt = db.prepare('INSERT INTO urls (longUrl, shortCode) VALUES (?, ?)');
    stmt.run(longUrl, shortCode, async function (err) {
        if (err) {
            return res.status(500).json({ error: 'Database error occurred' });
        }

        // Cache the mapping in Redis for fast redirection later (Expires in 24 hours)
        await redisClient.set(shortCode, longUrl, { EX: 86400 });

        const shortUrl = `${req.protocol}://${req.get('host')}/${shortCode}`;
        res.status(201).json({ longUrl, shortCode, shortUrl });
    });
    stmt.finalize();
});

// Endpoint to redirect short URL to long URL
app.get('/:shortCode', async (req, res) => {
    const { shortCode } = req.params;

    try {
        // Step A: Check Redis Cache first
        const cachedUrl = await redisClient.get(shortCode);
        if (cachedUrl) {
            return res.redirect(cachedUrl);
        }

        // Step B: Cache miss? Check SQLite Database
        db.get('SELECT longUrl FROM urls WHERE shortCode = ?', [shortCode], async (err, row) => {
            if (err || !row) {
                return res.status(404).send('URL not found');
            }

            // Step C: Re-populate Redis cache for next time, then redirect
            await redisClient.set(shortCode, row.longUrl, { EX: 86400 });
            return res.redirect(row.longUrl);
        });

    } catch (error) {
        res.status(500).send('Server error');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});