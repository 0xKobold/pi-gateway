/**
 * pi-gateway Types
 * 
 * Hermes-style messaging gateway types for pi-coding-agent
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================
// Platform Types
// ============================================

export type Platform = "discord" | "telegram" | "slack" | "whatsapp" | "signal" | "web" | "websocket";

export interface PlatformMessage {
  id: string;
  platform: Platform;
  channelId: string;
  userId: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly enabled: boolean;
  
  initialize(): Promise<void>;
  start(callbacks: PlatformCallbacks): Promise<void>;
  stop(): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<string>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  setTyping(channelId: string, isTyping: boolean): Promise<void>;
  getStatus(): { connected: boolean; latency?: number };
}

export interface PlatformCallbacks {
  onMessage(message: PlatformMessage): Promise<void>;
  onTyping?(userId: string, isTyping: boolean): void;
  onDisconnect?(): void;
  onConnect?(): void;
}

// ============================================
// Session Types
// ============================================

export type ResetPolicy = "daily" | "idle" | "both";

export interface SessionConfig {
  id: string;
  platform: Platform;
  channelId: string;
  userId: string;
  resetPolicy: ResetPolicy;
  dailyHour: number;
  idleMinutes: number;
  lastActivity: number;
  createdAt: number;
  isBackground: boolean;
  parentSessionId?: string;
  title?: string;
}

export interface Session {
  id: string;
  platform: Platform;
  channelId: string;
  userId: string;
  resetPolicy: ResetPolicy;
  dailyHour: number;
  idleMinutes: number;
  lastActivity: number;
  createdAt: number;
  isBackground: boolean;
  parentSessionId?: string;
  title?: string;
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// ============================================
// Security Types
// ============================================

export interface AllowlistEntry {
  platform: Platform;
  userId: string;
  addedAt: number;
  note?: string;
}

export interface PairingCode {
  code: string;
  platform: Platform;
  userId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

// ============================================
// Gateway Types
// ============================================

export interface GatewayConfig {
  port: number;
  host: string;
  tokens: string[];
  corsOrigins: string[];
  security: {
    allowAll: boolean;
    requirePairing: boolean;
  };
  sessions: {
    resetPolicy: ResetPolicy;
    dailyHour: number;
    idleMinutes: number;
  };
  platforms: Partial<Record<Platform, PlatformConfig>>;
}

export interface PlatformConfig {
  enabled: boolean;
  botToken?: string;
  apiKey?: string;
  allowedChannels?: string[];
  requireMention?: boolean;
}

export interface GatewayState {
  running: boolean;
  startedAt?: number;
  adapters: Map<Platform, PlatformAdapter>;
  sessions: Map<string, Session>;
  clients: Map<string, WebSocket>;
  stats: GatewayStats;
}

export interface GatewayStats {
  totalMessages: number;
  totalSessions: number;
  activePlatforms: number;
  uptime: number;
}

// ============================================
// Background Task Types
// ============================================

export type TaskStatus = "running" | "completed" | "failed" | "timeout";

export interface BackgroundTask {
  id: string;
  sessionId: string;
  command: string;
  status: TaskStatus;
  progress: number;
  progressMessage?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

// ============================================
// UI Types (pi Extension API)
// ============================================

export interface GatewayUI {
  setStatus(key: string, status: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, lines?: string[], options?: { placement?: string; timeout?: number }): void;
}

// ============================================
// API Types
// ============================================

export interface ApiRequest {
  method: string;
  params?: Record<string, unknown>;
  id?: string;
}

export interface ApiResponse {
  result?: unknown;
  error?: { code: number; message: string };
  id?: string;
}

// WebSocket message types
export interface WsMessage {
  type: string;
  id?: string;
  data?: unknown;
}
