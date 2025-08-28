import { config } from 'dotenv';
import { join } from 'path';

// Load environment variables from .env file for tests
config({ path: join(__dirname, '..', '.env') });