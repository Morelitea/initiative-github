/**
 * The key this app seals credentials with, and where it comes from.
 *
 * A member's GitHub token reaches whatever that member reaches, so it is sealed
 * with a key the database does not have. The sealing itself is the kit's — the
 * construction is the same in every app and breaks quietly when it is wrong.
 *
 * What is this app's, and what this file is, is **custody**: the key arrives in
 * the environment and is checked once at import, so a deployment with a
 * truncated one dies at boot rather than the first time somebody connects. An
 * operator who would rather it came from a KMS changes this and nothing else.
 */

import { createVault } from "initiative-app-kit";

import { config } from "./config.js";

const vault = createVault(config.encryptionKey);

export const seal = vault.seal;
export const open = vault.open;
