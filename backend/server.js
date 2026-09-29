import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import monthlyRoutes from './routes/monthly.js';
import cacheRoutes from './routes/cache.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import './config/clickhouse.js';
import './config/redis.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

app.use('/api/monthly', monthlyRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);
app.use('/api', cacheRoutes);

app.get('/api', (req, res) => {
  res.json({
    name: 'Weather Database System API',
    version: '1.0.0',
    endpoints: {
      'GET /api/monthly': 'Get monthly aggregated weather data',
      'GET /api/cache-status': 'Get Redis cache status',
      'POST /api/sync-now': 'Trigger cache refresh',
      'GET /health': 'Health check endpoint'
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    clickhouse_url: process.env.CLICKHOUSE_URL || 'http://localhost:8123'
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

