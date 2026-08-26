import { InitiativeChannel } from "initiative-app-kit";

import { config } from "./config.js";
import { PUBLIC_ID } from "./vocabulary.js";

let channel: InitiativeChannel | null = null;

export const initiative: InitiativeChannel = new Proxy({} as InitiativeChannel, {
  get(_target, key) {
    channel ??= new InitiativeChannel({
      publicId: PUBLIC_ID,
      secret: config.appSecret,
      baseUrl: config.initiativeBaseUrl,
    });
    const value = channel[key as keyof InitiativeChannel];
    return typeof value === "function" ? value.bind(channel) : value;
  },
});
