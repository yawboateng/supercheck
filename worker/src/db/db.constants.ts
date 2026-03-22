/**
 * Database Constants
 *
 * Single source of truth for database-related tokens and constants.
 * All modules that need the Drizzle ORM instance should reference this token.
 */

// NestJS dependency injection token for the Drizzle ORM instance.
// Used by DbModule to provide a single shared connection pool across
// ExecutionModule, K6Module, MonitorModule, and HealthModule.
export const DB_PROVIDER_TOKEN = 'DB_DRIZZLE';
