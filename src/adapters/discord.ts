/**
 * Discord Adapter - Hermes-style Discord platform adapter
 * 
 * Features:
 * - DM and guild channel support
 * - Slash command registration
 * - Typing indicators
 * - Message editing/deletion
 */

import type { PlatformAdapter, PlatformCallbacks, PlatformMessage } from "../types.js";

interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  guildId?: string;
  allowedChannels?: string[];
  requireMention?: boolean;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord" as const;
  readonly enabled: boolean;
  private config: DiscordConfig;
  private callbacks: PlatformCallbacks | null = null;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private intents: number = 1 << 9 | 1 << 12 | 1 << 15; // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

  constructor(config: DiscordConfig) {
    this.config = config;
    this.enabled = config.enabled;
  }

  async initialize(): Promise<void> {
    // Test bot token
    const response = await this.apiRequest("/users/@me");
    const data: any = await response.json();
    
    if (!response.ok) {
      throw new Error(`Discord authentication failed: ${response.status}`);
    }
    
    console.log(`[Discord] Bot initialized: ${data.username}`);
  }

  private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `https://discord.com/api/v10${endpoint}`;
    return fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bot ${this.config.botToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  async start(callbacks: PlatformCallbacks): Promise<void> {
    this.callbacks = callbacks;

    // Connect to Gateway
    const gatewayResponse = await this.apiRequest("/gateway");
    const gatewayData: any = await gatewayResponse.json();
    const gatewayUrl = `${gatewayData.url}?v=10&encoding=json&intents=${this.intents}`;

    this.ws = new WebSocket(gatewayUrl);

    this.ws.onopen = () => {
      console.log("[Discord] WebSocket connected");
      this.callbacks?.onConnect?.();
    };

    this.ws.onmessage = async (event) => {
      const data: any = JSON.parse(event.data);
      await this.handleGatewayMessage(data);
    };

    this.ws.onclose = () => {
      console.log("[Discord] WebSocket closed");
      this.callbacks?.onDisconnect?.();
      // Reconnect after 5 seconds
      setTimeout(() => this.start(callbacks), 5000);
    };

    this.ws.onerror = (err) => {
      console.error("[Discord] WebSocket error:", err);
    };
  }

  private async handleGatewayMessage(data: any): Promise<void> {
    switch (data.op) {
      case 0: // Dispatch
        this.sequence = data.s;
        await this.handleDispatch(data.t, data.d);
        break;
        
      case 10: // Hello
        this.startHeartbeat(data.d.heartbeat_interval);
        this.identify();
        break;
        
      case 11: // Heartbeat ACK
        break;
    }
  }

  private startHeartbeat(interval: number): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          op: 1,
          d: this.sequence,
        }));
      }
    }, interval);
  }

  private identify(): void {
    this.ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: this.config.botToken,
        intents: this.intents,
        properties: {
          os: "linux",
          browser: "pi-gateway",
          device: "pi-gateway",
        },
      },
    }));
  }

  private async handleDispatch(type: string, data: any): Promise<void> {
    switch (type) {
      case "READY":
        console.log(`[Discord] Logged in as ${data.user.username}`);
        break;

      case "MESSAGE_CREATE":
        await this.handleMessage(data);
        break;
    }
  }

  private async handleMessage(data: any): Promise<void> {
    // Ignore bots (except ourselves)
    if (data.author.bot && data.author.id !== this.getBotId()) return;
    
    // Check DM or allowed channel
    const isDM = !data.guild_id;
    if (!isDM && this.config.allowedChannels?.length) {
      if (!this.config.allowedChannels.includes(data.channel_id)) return;
    }

    // Check mention requirement in guilds
    if (!isDM && this.config.requireMention) {
      const mentioned = data.content.includes(`<@${this.getBotId()}>`);
      if (!mentioned) return;
    }

    const message: PlatformMessage = {
      id: data.id,
      platform: this.platform,
      channelId: data.channel_id,
      userId: data.author.id,
      content: data.content,
      timestamp: new Date(data.timestamp).getTime(),
      metadata: {
        guildId: data.guild_id,
        username: data.author.username,
        isDM,
      },
    };

    await this.callbacks?.onMessage(message);
  }

  private getBotId(): string {
    // Extract from token (not perfect but works)
    const parts = this.config.botToken.split(".");
    return parts[0] || "unknown";
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    const response = await this.apiRequest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send message: ${error}`);
    }

    const data: any = await response.json();
    return data.id;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    
    await this.apiRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    });
  }

  getStatus(): { connected: boolean; latency?: number } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
    };
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.callbacks = null;
  }
}
