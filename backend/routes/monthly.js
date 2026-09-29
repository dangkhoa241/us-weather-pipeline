import express from 'express';
import dotenv from 'dotenv';
import { clickhouseClient } from '../config/clickhouse.js';
import redisClient from '../config/redis.js';

dotenv.config();

const router = express.Router();
const REDIS_TTL_SEC = parseInt(process.env.REDIS_TTL_SEC || '3600', 10);

router.get('/', async (req, res) => {
  try {
    const city = req.query.city || 'Stockton';
    const redisKey = `weather:${city.toLowerCase()}:monthly`;
    
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      
      const cachedData = await redisClient.get(redisKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData);
        const data = parsed.data || [];
        const metadata = parsed.metadata || {};
        
        const formattedData = data.map(row => ({
          month: row.month,
          avg_temp_c: row.avg_temp_c !== null && row.avg_temp_c !== undefined ? parseFloat(row.avg_temp_c) : null,
          total_rain_mm: row.total_rain_mm !== null && row.total_rain_mm !== undefined ? parseFloat(row.total_rain_mm) : null,
          city: row.city,
          warehouse_load_time: row.warehouse_load_time
        }));
        
        const ttl = await redisClient.ttl(redisKey);
        const refreshInterval = metadata.refresh_interval_sec || REDIS_TTL_SEC || 3600;
        let sync_status = 'full';
        if (ttl < refreshInterval * 0.2) {
          sync_status = 'out-of-sync';
        } else if (ttl < refreshInterval * 0.6) {
          sync_status = 'partial';
        }
        
        return res.json({
          data: formattedData,
          source: 'redis',
          last_updated: metadata.cache_timestamp || new Date().toISOString(),
          cache_status: 'active',
          sync_status: sync_status,
          ttl_seconds: ttl,
          count: formattedData.length
        });
      }
    } catch (redisError) {
      console.warn('Redis connection error, falling back to ClickHouse:', redisError.message);
    }

    const escapedCity = city.replace(/'/g, "''");
    
    const query = `
      SELECT 
        city,
        month,
        avg_temp_c,
        total_rain_mm,
        warehouse_load_time
      FROM weather_dw.monthly_agg
      WHERE city = '${escapedCity}'
      ORDER BY month ASC
    `;

    const result = await clickhouseClient.query({
      query,
      format: 'JSONEachRow',
    });

    const data = await result.json();
    
    if (!data || !Array.isArray(data)) {
      return res.json({
        data: [],
        source: 'clickhouse',
        last_updated: new Date().toISOString(),
        cache_status: 'none',
        count: 0,
        message: 'No monthly data found. Please run the ETL pipeline first: node etlToClickHouse.js'
      });
    }
    
    const formattedData = data.map(row => ({
      month: row.month,
      avg_temp_c: row.avg_temp_c !== null && row.avg_temp_c !== undefined ? parseFloat(row.avg_temp_c) : null,
      total_rain_mm: row.total_rain_mm !== null && row.total_rain_mm !== undefined ? parseFloat(row.total_rain_mm) : null,
      city: row.city,
      warehouse_load_time: row.warehouse_load_time
    }));

    res.json({
      data: formattedData,
      source: 'clickhouse',
      last_updated: new Date().toISOString(),
      cache_status: 'none',
      sync_status: 'out-of-sync',
      count: formattedData.length
    });

  } catch (error) {
    console.error('Error fetching monthly data:', error);
    
    let errorMessage = error.message || 'Unknown error occurred';
    let helpfulMessage = '';
    let statusCode = 500;
    
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connect') || 
        error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      helpfulMessage = 'ClickHouse is not running. Please start ClickHouse.';
      statusCode = 503;
    } else if (errorMessage.includes('Table') && errorMessage.includes('doesn\'t exist')) {
      helpfulMessage = 'The monthly_agg table does not exist. Please run: node etlToClickHouse.js';
    } else if (errorMessage.includes('Connection')) {
      helpfulMessage = 'Cannot connect to ClickHouse. Ensure ClickHouse is running on http://localhost:8123';
      statusCode = 503;
    } else if (errorMessage.includes('database') || errorMessage.includes('Database')) {
      helpfulMessage = 'The weather_dw database does not exist. Please run: node etlToClickHouse.js';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch monthly weather data',
      message: errorMessage,
      helpful_message: helpfulMessage || 'Check server logs for details',
      source: 'error'
    });
  }
});

export default router;
