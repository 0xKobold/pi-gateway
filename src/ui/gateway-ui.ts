/**
 * Gateway UI Component
 * 
 * Integrates with pi's ExtensionContext.ui API for:
 * - Status display in footer
 * - Notifications
 * - Widget panels
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GatewayState } from "../types.js";

export class GatewayUI {
  private ctx: ExtensionContext | null = null;
  private statusEntries: Map<string, string> = new Map();
  private widgetTimers: Map<string, Timer> = new Map();

  setContext(ctx: ExtensionContext): void {
    try {
      this.ctx = ctx;
      this.updateFooterStatus();
    } catch (e) {
      console.warn("[GatewayUI] Failed to set context:", e);
      this.ctx = null;
    }
  }

  setStatus(key: string, status: string): void {
    this.statusEntries.set(key, status);
    // Only update footer if context is set (avoid errors during init)
    if (this.ctx && ('ui' in this.ctx) && this.ctx.ui) {
      this.updateFooterStatus();
    }
  }

  clearStatus(key: string): void {
    this.statusEntries.delete(key);
    this.updateFooterStatus();
  }

  private updateFooterStatus(): void {
    // Check both ctx and ui exist
    if (!this.ctx || !('ui' in this.ctx) || !this.ctx.ui) {
      return;
    }
    const parts: string[] = [];
    if (this.statusEntries.has("gateway")) parts.push(this.statusEntries.get("gateway")!);
    if (this.statusEntries.has("stats")) parts.push(this.statusEntries.get("stats")!);
    if (this.statusEntries.has("platforms")) parts.push(this.statusEntries.get("platforms")!);
    const text = parts.join(" | ") || "Gateway";
    if (typeof this.ctx.ui.setStatus === 'function') {
      this.ctx.ui.setStatus("gateway", text);
    }
  }

  notify(message: string, type: "info" | "warning" | "error" | "success" = "info"): void {
    const safeType = type === "success" ? "info" : type;
    if (!this.ctx?.ui) { console.log(`[Gateway] ${type.toUpperCase()}: ${message}`); return; }
    const ui = this.ctx.ui;
    if (typeof ui.notify === 'function') {
      ui.notify(message, safeType);
    } else {
      console.log(`[Gateway] ${type.toUpperCase()}: ${message}`);
    }
  }

  setWidget(key: string, lines?: string[], options?: { placement?: "aboveEditor" | "belowEditor"; timeout?: number }): void {
    if (this.widgetTimers.has(key)) { clearTimeout(this.widgetTimers.get(key)); this.widgetTimers.delete(key); }
    
    if (!this.ctx?.ui) {
      if (lines) { console.log(`[Gateway Widget: ${key}]`); lines.forEach(l => console.log(`  ${l}`)); }
      return;
    }

    const ui = this.ctx.ui;
    const widgetKey = `gateway-${key}`;
    
    if (typeof ui.setWidget === 'function') {
      if (lines) {
        ui.setWidget(widgetKey, lines, { placement: options?.placement || "belowEditor" });
      } else {
        ui.setWidget(widgetKey, undefined);
      }
    } else {
      if (lines) { console.log(`[Gateway Widget: ${key}]`); lines.forEach(l => console.log(`  ${l}`)); }
    }

    const timeout = options?.timeout ?? (key === "status" ? 15000 : 30000);
    if (timeout > 0 && lines) {
      const timer = setTimeout(() => {
        this.ctx?.ui.setWidget(`gateway-${key}`, undefined);
        this.widgetTimers.delete(key);
      }, timeout);
      this.widgetTimers.set(key, timer);
    }
  }

  updateFromState(state: GatewayState): void {
    this.setStatus("gateway", state.running ? "🟢 Gateway" : "🔴 Gateway");
    this.setStatus("stats", `Clients: ${state.clients.size}`);
    const activePlatforms = Array.from(state.adapters.keys()).join(", ");
    this.setStatus("platforms", activePlatforms ? `Platforms: ${activePlatforms}` : "Platforms: none");
  }

  showStatusWidget(state: GatewayState, config: any): void {
    const lines = [
      `Status: ${state.running ? "🟢 Running" : "🔴 Stopped"}`,
      `Port: ${config.port}`,
      `Clients: ${state.clients.size}`,
      `Sessions: ${state.sessions.size}`,
      `Platforms: ${state.adapters.size}`,
      "",
      `Session Reset: ${config.sessions.resetPolicy}`,
      `  - Daily at ${config.sessions.dailyHour}:00`,
      `  - Idle after ${config.sessions.idleMinutes} min`,
      "",
      `Security: ${config.security.allowAll ? "Allow all" : "Allowlist only"}`,
    ];
    this.setWidget("status", lines, { placement: "belowEditor", timeout: 15000 });
  }

  showHelpWidget(): void {
    const lines = [
      "pi Gateway Commands:",
      "",
      "  /gateway start [port]  - Start gateway",
      "  /gateway stop         - Stop gateway",
      "  /gateway restart      - Restart gateway",
      "  /gateway status       - Show status",
      "  /gateway sessions     - List sessions",
      "  /gateway pair <code>  - Approve pairing",
      "  /gateway allow <p> <u>- Add to allowlist",
      "  /gateway config       - Show config",
      "  /gateway platforms    - Platform status",
      "",
      "Hermes-style Features:",
      "  - Per-chat sessions with reset policies",
      "  - Platform adapters (Discord, etc.)",
      "  - Background task support",
      "  - Allowlist security",
    ];
    this.setWidget("help", lines, { placement: "belowEditor", timeout: 30000 });
  }

  destroy(): void {
    for (const timer of this.widgetTimers.values()) clearTimeout(timer);
    this.widgetTimers.clear();
    this.statusEntries.clear();
    this.ctx = null;
  }
}

export const gatewayUI = new GatewayUI();
