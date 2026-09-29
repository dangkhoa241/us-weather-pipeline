import { createClient } from '@clickhouse/client';
import dotenv from 'dotenv';

dotenv.config();

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';

export const clickhouseClient = createClient({
  url: CLICKHOUSE_URL,
});

