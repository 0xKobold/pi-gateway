/**
 * Security Layer - Hermes-style allowlists and DM pairing
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "node:crypto";
import type { Platform, AllowlistEntry, PairingCode } from "../types.js";

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const GATEWAY_DIR = join(KOBOLD_DIR, "gateway");
const SECURITY_DB = join(GATEWAY_DIR, "security.db");
const CONFIG_FILE = join(GATEWAY_DIR, "security.json");

let db: Database | null = null;

interface SecurityConfig {
  allowAll: boolean;
  requirePairing: boolean;
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

const defaultConfig: SecurityConfig = {
  allowAll: true,
  requirePairing: false,
  rateLimit: { maxRequests: 60, windowMs: 60000 },
};

/**
 * Initialize security database
 */
export function initSecurityStore(): Database {
  if (db) return db;

  if (!existsSync(GATEWAY_DIR)) {
    mkdirSync(GATEWAY_DIR, { recursive: true });
  }

  db = new Database(SECURITY_DB);
  db.run("PRAGMA journal_mode = WAL;");

  // Allowlist table
  db.run(`
    CREATE TABLE IF NOT EXISTS allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      note TEXT,
      UNIQUE(platform, user_id)
    )
  `);

  // Pairing codes table
  db.run(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Rate limiting table
  db.run(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      identifier TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start INTEGER NOT NULL
    )
  `);

  console.log("[Security] Database initialized");
  return db;
}

/**
 * Load security config
 */
export function loadSecurityConfig(): SecurityConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
    }
  } catch { /* ignore */ }
  return { ...defaultConfig };
}

/**
 * Save security config
 */
export function saveSecurityConfig(config: Partial<SecurityConfig>): void {
  const current = loadSecurityConfig();
  const updated = { ...current, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
}

/**
 * Check if user is allowed
 */
export function isUserAllowed(platform: Platform, userId: string): boolean {
  const config = loadSecurityConfig();
  if (config.allowAll) return true;

  const database = initSecurityStore();
  const entry = database.query(`
    SELECT 1 FROM allowlist WHERE platform = ? AND user_id = ?
  `).get(platform, userId);

  return !!entry;
}

/**
 * Add user to allowlist
 */
export function addToAllowlist(platform: Platform, userId: string, note?: string): void {
  const database = initSecurityStore();
  database.run(`
    INSERT OR REPLACE INTO allowlist (platform, user_id, added_at, note)
    VALUES (?, ?, ?, ?)
  `, [platform, userId, Date.now(), note ?? null]);
}

/**
 * Remove user from allowlist
 */
export function removeFromAllowlist(platform: Platform, userId: string): boolean {
  const database = initSecurityStore();
  const result = database.run(
    "DELETE FROM allowlist WHERE platform = ? AND user_id = ?",
    [platform, userId]
  );
  return result.changes > 0;
}

/**
 * List allowlisted users
 */
export function listAllowlistedUsers(platform?: Platform): AllowlistEntry[] {
  const database = initSecurityStore();
  
  const query = platform 
    ? "SELECT * FROM allowlist WHERE platform = ? ORDER BY added_at DESC"
    : "SELECT * FROM allowlist ORDER BY platform, added_at DESC";
  
  const rows = platform 
    ? database.query(query).all(platform) as any[]
    : database.query(query).all() as any[];
  
  return rows.map(row => ({
    platform: row.platform as Platform,
    userId: row.user_id,
    addedAt: row.added_at,
    note: row.note ?? undefined,
  }));
}

/**
 * Generate pairing code
 */
export function generatePairingCode(platform: Platform, userId: string): string {
  const database = initSecurityStore();
  
  // Generate 8-character code
  const code = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase();
  const now = Date.now();
  const expiresAt = now + (60 * 60 * 1000); // 1 hour

  database.run(`
    INSERT INTO pairing_codes (code, platform, user_id, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, 0)
  `, [code, platform, userId, now, expiresAt]);

  console.log(`[Security] Generated pairing code ${code} for ${platform}/${userId}`);
  return code;
}

/**
 * Approve pairing code
 */
export function approvePairingCode(code: string): boolean {
  const database = initSecurityStore();
  
  const entry = database.query(`
    SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?
  `).get(code, Date.now()) as any;

  if (!entry) {
    console.log(`[Security] Pairing code ${code} not found or expired`);
    return false;
  }

  // Add to allowlist
  addToAllowlist(entry.platform, entry.user_id);

  // Mark code as used
  database.run("UPDATE pairing_codes SET used = 1 WHERE code = ?", [code]);

  console.log(`[Security] Approved pairing: ${entry.platform}/${entry.user_id}`);
  return true;
}

/**
 * List pending pairing codes
 */
export function listPendingPairingCodes(): PairingCode[] {
  const database = initSecurityStore();
  const now = Date.now();
  
  const rows = database.query(`
    SELECT * FROM pairing_codes WHERE used = 0 AND expires_at > ?
    ORDER BY created_at ASC
  `).all(now) as any[];

  return rows.map(row => ({
    code: row.code,
    platform: row.platform as Platform,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used === 1,
  }));
}

/**
 * Check rate limit
 */
export function checkRateLimit(identifier: string, maxRequests?: number, windowMs?: number): boolean {
  const config = loadSecurityConfig();
  const max = maxRequests ?? config.rateLimit.maxRequests;
  const window = windowMs ?? config.rateLimit.windowMs;
  
  const database = initSecurityStore();
  const now = Date.now();
  
  const entry = database.query(`
    SELECT * FROM rate_limits WHERE identifier = ?
  `).get(identifier) as any;

  if (!entry || now - entry.window_start > window) {
    database.run(`
      INSERT OR REPLACE INTO rate_limits (identifier, count, window_start)
      VALUES (?, 1, ?)
    `, [identifier, now]);
    return true;
  }

  if (entry.count >= max) {
    console.log(`[Security] Rate limit exceeded for ${identifier}`);
    return false;
  }

  database.run(`UPDATE rate_limits SET count = count + 1 WHERE identifier = ?`, [identifier]);
  return true;
}

/**
 * Clean up expired pairing codes
 */
export function cleanupExpiredCodes(): number {
  const database = initSecurityStore();
  const result = database.run("DELETE FROM pairing_codes WHERE expires_at < ?", [Date.now()]);
  return result.changes;
}
