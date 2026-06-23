/**
 * Chat client entry point. Renders the Ink-based App component and
 * waits for it to exit. Replaces the readline-era implementation.
 *
 * This is a thin shim — all the chat logic lives under src/cli/chat/.
 * Kept as `chat.ts` (no .tsx) because it's a plain function caller;
 * the JSX lives in the components themselves.
 */

import { render } from "ink";
import React from "react";
import { App, type AppProps } from "./chat/App.js";

export interface ChatOptions {
  url?: string;
  token?: string;
  channel?: string;
}

export async function startChat(opts: ChatOptions): Promise<void> {
  const url = opts.url ?? "ws://127.0.0.1:3000";
  const token = opts.token ?? process.env.CRABMEAT_TOKEN ?? "";
  const channel = opts.channel;

  const props: AppProps = {
    url,
    token,
    ...(channel ? { channel } : {}),
  };

  const instance = render(React.createElement(App, props));
  await instance.waitUntilExit();
}
