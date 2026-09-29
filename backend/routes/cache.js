import express from 'express';
import redisClient from '../config/redis.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const router = express.Router();
const execAsync = promisify(exec);

router.get('/cache-status', async (req, res) => {
  try {
    const city = req.query.city || 'Stockton';
    const redisKey = `weather:${city.toLowerCase()}:monthly`;

    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }

      const exists = await redisClient.exists(redisKey);
      
      if (exists) {
        const ttl = await redisClient.ttl(redisKey);
        const cachedData = await redisClient.get(redisKey);
        const parsed = cachedData ? JSON.parse(cachedData) : null;
        
        return res.json({
          cache_valid: true,
          ttl_seconds: ttl,
          ttl_minutes: Math.floor(ttl / 60),
          key: redisKey,
          source: 'redis',
          metadata: parsed?.metadata || null,
          data_count: parsed?.data?.length || 0
        });
      } else {
        return res.json({
          cache_valid: false,
          ttl_seconds: 0,
          ttl_minutes: 0,
          key: redisKey,
          source: 'none',
          message: 'Redis key not found. Run: npm run etl:redis to cache data.'
        });
      }
    } catch (redisError) {
      console.error('Redis connection error:', redisError.message);
      return res.json({
        cache_valid: false,
        ttl_seconds: 0,
        ttl_minutes: 0,
        key: redisKey,
        source: 'error',
        message: `Redis connection failed: ${redisError.message}`
      });
    }

  } catch (error) {
    console.error('Error checking cache status:', error);
    res.status(500).json({
      error: 'Failed to check cache status',
      message: error.message
    });
  }
});

router.post('/sync-now', async (req, res) => {
  try {
    const city = req.query.city || 'Stockton';

    try {
      const { stdout, stderr } = await execAsync('npm run etl:redis');
      
      if (stderr && !stderr.includes('warning')) {
        console.error('ETL script warnings:', stderr);
      }
      
      res.json({
        success: true,
        message: 'Redis cache refreshed successfully from ClickHouse',
        city: city,
        timestamp: new Date().toISOString()
      });
      
    } catch (execError) {
      console.error('Error running ETL script:', execError);
      res.status(500).json({
        error: 'Failed to run Redis ETL script',
        message: execError.message
      });
    }

  } catch (error) {
    console.error('Error syncing cache:', error);
    res.status(500).json({
      error: 'Failed to sync cache',
      message: error.message
    });
  }
});

export default router;
