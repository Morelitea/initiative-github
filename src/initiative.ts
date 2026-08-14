/**
 * This app's one client for calling Initiative.
 *
 * A single instance, built at import time from configuration, so every caller
 * signs with the same secret against the same address and there is no second
 * place where a path could be spelled differently. The kit owns the paths and
 * the signing; this file owns only the fact that there is exactly one of them.
 *
 * The address is the **server-to-server** one — see `config.ts` on why that is
 * not the address a browser uses.
 */

import { InitiativeChannel } from "initiative-app-kit";

import { config } from "./config.js";
import { manifest } from "./manifest.config.js";

export const initiative = new InitiativeChannel({
  publicId: manifest.service.public_id,
  secret: config.appSecret,
  baseUrl: config.initiativeBaseUrl,
});
