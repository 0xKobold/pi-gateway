/**
 * Session Store - Hermes-style per-chat session management
 * 
 * Features:
 * - Per-chat sessions with unique IDs
 * - Reset policies: daily (hour-based) and idle (minutes-based)
 * - Session persistence across restarts
 * - Background session isolation
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import type { Session, ChatMessage, Platform, ResetPolicy } from "../types.js";

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const GATEWAY_DIR = join(KOBOLD_DIR, "gateway");
const SESSIONS_DB = join(GATEWAY_DIR, "sessions.db");

let db: Database | null = null;

// In-memory session cache
const sessionCache = new Map<string, Session>();

/**
 * Initialize session database
 */
export function initSessionStore(): Database {
  if (db) return db;

  if (!existsSync(GATEWAY_DIR)) {
    mkdirSync(GATEWAY_DIR, { recursive: true });
  }

  db = new Database(SESSIONS_DB);
  db.run("PRAGMA journal_mode = WAL;");

  // Sessions table
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reset_policy TEXT NOT NULL DEFAULT 'idle',
      daily_hour INTEGER NOT NULL DEFAULT 4,
      idle_minutes INTEGER NOT NULL DEFAULT 1440,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      is_background INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      title TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    )
  `);

  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_platform_channel ON sessions(platform, channel_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`);

  console.log("[SessionStore] Database initialized");
  return db;
}

/**
 * Generate unique session ID
 */
export function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Get session key (platform:channelId)
 */
export function getSessionKey(platform: Platform, channelId: string): string {
  return `${platform}:${channelId}`;
}

/**
 * Get or create session for a platform/channel
 */
export function getOrCreateSession(
  platform: Platform,
  channelId: string,
  userId: string,
  config?: {
    resetPolicy?: ResetPolicy;
    dailyHour?: number;
    idleMinutes?: number;
  }
): Session {
  const key = getSessionKey(platform, channelId);
  
  // Check in-memory cache first
  const cached = sessionCache.get(key);
  if (cached) {
    // Check if session needs reset
    if (shouldResetSession(cached)) {
      sessionCache.delete(key);
      db?.run("DELETE FROM sessions WHERE id = ?", [cached.id]);
    } else {
      // Update last activity
      cached.lastActivity = Date.now();
      touchSession(cached.id);
      return cached;
    }
  }

  // Check database
  const database = initSessionStore();
  const row = database.query(`
    SELECT * FROM sessions 
    WHERE platform = ? AND channel_id = ? AND is_background = 0
    ORDER BY last_activity DESC
    LIMIT 1
  `).get(platform, channelId) as any;

  if (row && !shouldResetSession(row)) {
    const session = rowToSession(row);
    session.messages = loadMessages(session.id);
    sessionCache.set(key, session);
    touchSession(session.id);
    return session;
  }

  // Create new session
  const id = generateSessionId();
  const now = Date.now();
  
  const session: Session = {
    id,
    platform,
    channelId,
    userId,
    resetPolicy: config?.resetPolicy ?? "idle",
    dailyHour: config?.dailyHour ?? 4,
    idleMinutes: config?.idleMinutes ?? 1440,
    lastActivity: now,
    createdAt: now,
    isBackground: false,
    messages: [],
  };

  database.run(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `, [id, platform, channelId, userId, session.resetPolicy, session.dailyHour, session.idleMinutes, now, now]);

  sessionCache.set(key, session);
  console.log(`[SessionStore] Created session ${id.slice(0, 12)}... for ${platform}/${channelId}`);
  return session;
}

/**
 * Create a background session
 */
export function createBackgroundSession(
  platform: Platform,
  channelId: string,
  userId: string,
  parentSessionId?: string
): Session {
  const database = initSessionStore();
  const id = generateSessionId();
  const now = Date.now();

  const session: Session = {
    id,
    platform,
    channelId,
    userId,
    resetPolicy: "idle",
    dailyHour: 4,
    idleMinutes: 1440,
    lastActivity: now,
    createdAt: now,
    isBackground: true,
    parentSessionId,
    messages: [],
  };

  database.run(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [id, platform, channelId, userId, session.resetPolicy, session.dailyHour, session.idleMinutes, now, now, parentSessionId ?? null]);

  console.log(`[SessionStore] Created background session ${id.slice(0, 12)}...`);
  return session;
}

/**
 * Check if session should be reset
 */
function shouldResetSession(session: Session | any): boolean {
  const now = Date.now();
  
  // Check idle timeout
  const idleMs = (session.idleMinutes || 1440) * 60 * 1000;
  if (now - (session.lastActivity || session.last_activity) > idleMs) {
    console.log(`[SessionStore] Session reset: idle timeout`);
    return true;
  }

  // Check daily reset
  const policy = session.resetPolicy || session.reset_policy;
  if (policy === "daily" || policy === "both") {
    const lastActivity = new Date(session.lastActivity || session.last_activity);
    const nowDate = new Date(now);
    const hour = session.dailyHour || session.daily_hour || 4;
    
    if (lastActivity.getHours() < hour && nowDate.getHours() >= hour && lastActivity.getDate() !== nowDate.getDate()) {
      console.log(`[SessionStore] Session reset: daily at ${hour}:00`);
      return true;
    }
  }

  return false;
}

/**
 * Load messages for a session
 */
function loadMessages(sessionId: string): ChatMessage[] {
  const database = initSessionStore();
  const rows = database.query(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
  `).all(sessionId) as any[];

  return rows.map(row => ({
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    timestamp: row.timestamp,
  }));
}

/**
 * Add message to session
 */
export function addMessage(sessionId: string, role: "user" | "assistant" | "system", content: string): ChatMessage {
  const database = initSessionStore();
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = Date.now();

  database.run(`
    INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `, [id, sessionId, role, content, timestamp]);

  // Update session last activity
  touchSession(sessionId);

  const message: ChatMessage = { id, role, content, timestamp };

  // Update in-memory cache
  for (const session of sessionCache.values()) {
    if (session.id === sessionId) {
      session.messages.push(message);
      break;
    }
  }

  return message;
}

/**
 * Update session last activity
 */
export function touchSession(sessionId: string): void {
  const database = initSessionStore();
  database.run("UPDATE sessions SET last_activity = ? WHERE id = ?", [Date.now(), sessionId]);
}

/**
 * Get session by ID
 */
export function getSession(sessionId: string): Session | null {
  for (const session of sessionCache.values()) {
    if (session.id === sessionId) return session;
  }

  const database = initSessionStore();
  const row = database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
  if (!row) return null;

  const session = rowToSession(row);
  session.messages = loadMessages(session.id);
  return session;
}

/**
 * Get session by platform channel
 */
export function getSessionByChannel(platform: Platform, channelId: string): Session | null {
  const key = getSessionKey(platform, channelId);
  return sessionCache.get(key) || null;
}

/**
 * Delete session
 */
export function deleteSession(sessionId: string): void {
  const database = initSessionStore();
  database.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
  database.run("DELETE FROM sessions WHERE id = ?", [sessionId]);

  // Remove from cache
  for (const [key, session] of sessionCache) {
    if (session.id === sessionId) {
      sessionCache.delete(key);
      break;
    }
  }
}

/**
 * List sessions
 */
export function listSessions(platform?: Platform): Session[] {
  const database = initSessionStore();
  
  const query = platform 
    ? "SELECT * FROM sessions WHERE platform = ? AND is_background = 0 ORDER BY last_activity DESC"
    : "SELECT * FROM sessions WHERE is_background = 0 ORDER BY last_activity DESC";
  
  const rows = platform 
    ? database.query(query).all(platform) as any[]
    : database.query(query).all() as any[];
  
  return rows.map(row => {
    const session = rowToSession(row);
    session.messages = loadMessages(session.id);
    return session;
  });
}

/**
 * Set session title
 */
export function setSessionTitle(sessionId: string, title: string): void {
  const database = initSessionStore();
  database.run("UPDATE sessions SET title = ? WHERE id = ?", [title, sessionId]);

  for (const session of sessionCache.values()) {
    if (session.id === sessionId) {
      session.title = title;
      break;
    }
  }
}

// Helper to convert DB row to Session
function rowToSession(row: any): Session {
  return {
    id: row.id,
    platform: row.platform as Platform,
    channelId: row.channel_id,
    userId: row.user_id,
    resetPolicy: row.reset_policy as ResetPolicy,
    dailyHour: row.daily_hour,
    idleMinutes: row.idle_minutes,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    isBackground: row.is_background === 1,
    parentSessionId: row.parent_session_id ?? undefined,
    title: row.title ?? undefined,
    messages: [],
  };
}

/**
 * Get session count
 */
export function getSessionCount(): number {
  return sessionCache.size;
}

/**
 * Get session stats
 */
export function getSessionStats(): { total: number; byPlatform: Record<string, number> } {
  const byPlatform: Record<string, number> = {};
  let total = 0;

  for (const session of sessionCache.values()) {
    if (!session.isBackground) {
      total++;
      byPlatform[session.platform] = (byPlatform[session.platform] || 0) + 1;
    }
  }

  return { total, byPlatform };
}

/**
 * Clean up stale sessions
 */
export function cleanupStaleSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const database = initSessionStore();
  const cutoff = Date.now() - maxAgeMs;
  const result = database.run(`
    DELETE FROM messages WHERE session_id IN (
      SELECT id FROM sessions WHERE last_activity < ? AND is_background = 0
    )
  `, [cutoff]);
  const result2 = database.run("DELETE FROM sessions WHERE last_activity < ? AND is_background = 0", [cutoff]);
  
  // Clear cache
  sessionCache.clear();
  
  return result2.changes;
}
