/**
 * pi-gateway Client Demo
 * 
 * Demonstrates how to connect to the gateway and send prompts.
 * 
 * Run: npx tsx tests/client-demo.ts
 */

import WebSocket from "ws";

// Configuration
const WS_URL = process.env.WS_URL || "ws://localhost:3848/ws";
const TOKEN = process.env.TOKEN || "";

// Helper to send message and wait for response
function send(ws: WebSocket, msg: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2, 10);
    
    const handler = (data: WebSocket.Data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.id === id) {
          ws.off("message", handler);
          resolve(response);
        }
      } catch (err) {
        reject(err);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ ...msg, id }));

    setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Request timeout"));
    }, 30000);
  });
}

// Helper to stream events
function streamEvents(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === "event") {
        const event = msg.data;
        
        // Text delta
        if (event?.assistantMessageEvent?.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        
        // Thinking
        if (event?.assistantMessageEvent?.type === "thinking_delta") {
          // Skip thinking for cleaner output
        }
        
        // Tool call
        if (event?.assistantMessageEvent?.type === "tool_call") {
          console.log("\n\n[Tool Call]", JSON.stringify(event.assistantMessageEvent, null, 2));
        }
      }
    });

    // Resolve when closed
    ws.on("close", () => resolve());
  });
}

// Main demo
async function main() {
  console.log("=".repeat(50));
  console.log("🔌  pi Gateway Client Demo");
  console.log("=".repeat(50));
  console.log("");
  console.log(`Connecting to: ${WS_URL}`);
  if (TOKEN) console.log("Token: configured");
  console.log("");

  // Connect
  const headers: Record<string, string> = {};
  if (TOKEN) {
    headers["Authorization"] = `Bearer ${TOKEN}`;
  }

  const ws = new WebSocket(WS_URL, { headers });

  ws.on("open", () => {
    console.log("✅ Connected!");
    console.log("");
  });

  ws.on("error", (err) => {
    console.error("❌ Connection error:", err.message);
    process.exit(1);
  });

  ws.on("close", () => {
    console.log("\n\n🔌 Disconnected");
    process.exit(0);
  });

  // Wait for connected event
  await new Promise<void>((resolve) => {
    ws.once("message", (data) => {
      const msg = JSON.parse(data.toString());
      console.log("Received:", msg.type, msg.data);
      resolve();
    });
  });

  // Run demo commands
  const commands = [
    {
      name: "Ping",
      run: async () => {
        console.log("\n--- Testing ping ---");
        const response = await send(ws, { type: "ping" });
        console.log("Pong:", (response as { data: { time: number } }).data);
      },
    },
    {
      name: "Get State",
      run: async () => {
        console.log("\n--- Getting state ---");
        const response = await send(ws, { type: "get_state" });
        const data = (response as { data: { sessionId: string; isStreaming: boolean } }).data;
        console.log("State:", JSON.stringify(data, null, 2));
      },
    },
    {
      name: "Get Models",
      run: async () => {
        console.log("\n--- Getting models ---");
        const response = await send(ws, { type: "get_models" });
        const data = (response as { data: { models: unknown[] } }).data;
        console.log("Models:", data.models.length);
        data.models.slice(0, 3).forEach((m: unknown) => console.log(" ", JSON.stringify(m)));
      },
    },
    {
      name: "Send Prompt (streaming)",
      run: async () => {
        console.log("\n--- Sending prompt (streaming) ---");
        const prompt = "What is 2 + 2? Answer briefly.";
        
        // Start streaming in background
        const streamPromise = streamEvents(ws);
        
        // Send prompt
        ws.send(JSON.stringify({
          type: "prompt",
          id: "demo-prompt",
          data: { message: prompt },
        }));
        
        // Wait for response
        const response = await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "response" && msg.id === "demo-prompt") {
              resolve();
            }
          });
        });
        
        await streamPromise;
        console.log("\n\n✅ Prompt complete!");
      },
    },
  ];

  // Run commands sequentially
  for (const cmd of commands) {
    try {
      await cmd.run();
      // Small delay between commands
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`❌ ${cmd.name} failed:`, err);
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log("Demo complete!");
  console.log("=".repeat(50));
  console.log("");
  console.log("Try connecting from a browser or other client:");
  console.log(`  WebSocket: ${WS_URL}`);
  console.log(`  HTTP:      ${WS_URL.replace("ws://", "http://").replace("/ws", "/")}`);
  console.log("");

  // Keep connection open for manual testing
  console.log("Press Ctrl+C to disconnect, or try sending more prompts...\n");
}

// Handle errors
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});

main().catch(console.error);
