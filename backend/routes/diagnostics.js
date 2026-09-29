import express from 'express';
import { clickhouseClient } from '../config/clickhouse.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    clickhouse_url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    checks: {}
  };

  try {
    try {
      await clickhouseClient.query({ query: 'SELECT 1' });
      diagnostics.checks.connection = {
        status: 'success',
        message: 'ClickHouse connection successful'
      };
    } catch (err) {
      diagnostics.checks.connection = {
        status: 'error',
        message: `Cannot connect to ClickHouse: ${err.message}`
      };
      return res.json(diagnostics);
    }

    try {
      const dbCheck = await clickhouseClient.query({
        query: `SELECT name FROM system.databases WHERE name = 'weather_dw'`,
        format: 'JSONEachRow',
      });
      const dbResult = await dbCheck.json();
      
      if (dbResult.length > 0) {
        diagnostics.checks.database = {
          status: 'success',
          message: 'weather_dw database exists'
        };
      } else {
        diagnostics.checks.database = {
          status: 'warning',
          message: 'weather_dw database does not exist. Run: node etlToClickHouse.js'
        };
        return res.json(diagnostics);
      }
    } catch (err) {
      diagnostics.checks.database = {
        status: 'error',
        message: `Error checking database: ${err.message}`
      };
    }

    try {
      const tableCheck = await clickhouseClient.query({
        query: `SELECT name FROM system.tables WHERE database = 'weather_dw' AND name = 'monthly_agg'`,
        format: 'JSONEachRow',
      });
      const tableResult = await tableCheck.json();
      
      if (tableResult.length > 0) {
        diagnostics.checks.table = {
          status: 'success',
          message: 'monthly_agg table exists'
        };
      } else {
        diagnostics.checks.table = {
          status: 'warning',
          message: 'monthly_agg table does not exist. Run: node etlToClickHouse.js'
        };
        return res.json(diagnostics);
      }
    } catch (err) {
      diagnostics.checks.table = {
        status: 'error',
        message: `Error checking table: ${err.message}`
      };
    }

    try {
      const countQuery = await clickhouseClient.query({
        query: `SELECT count() as total FROM weather_dw.monthly_agg`,
        format: 'JSONEachRow',
      });
      const countResult = await countQuery.json();
      const totalRows = countResult[0]?.total || 0;
      
      diagnostics.checks.data = {
        status: totalRows > 0 ? 'success' : 'warning',
        message: totalRows > 0 
          ? `Table has ${totalRows} rows` 
          : 'Table exists but has no data. Run: node etlToClickHouse.js',
        row_count: totalRows
      };
    } catch (err) {
      diagnostics.checks.data = {
        status: 'error',
        message: `Error counting rows: ${err.message}`
      };
    }

    try {
      const sampleQuery = await clickhouseClient.query({
        query: `SELECT * FROM weather_dw.monthly_agg WHERE city = 'Stockton' LIMIT 1`,
        format: 'JSONEachRow',
      });
      const sampleResult = await sampleQuery.json();
      
      diagnostics.checks.sample_query = {
        status: sampleResult.length > 0 ? 'success' : 'warning',
        message: sampleResult.length > 0 
          ? 'Sample query successful' 
          : 'No data found for Stockton. Run: node etlToClickHouse.js',
        sample_data: sampleResult.length > 0 ? sampleResult[0] : null
      };
    } catch (err) {
      diagnostics.checks.sample_query = {
        status: 'error',
        message: `Error running sample query: ${err.message}`
      };
    }

  } catch (error) {
    diagnostics.error = {
      message: error.message,
      stack: error.stack
    };
  }

  res.json(diagnostics);
});

export default router;
