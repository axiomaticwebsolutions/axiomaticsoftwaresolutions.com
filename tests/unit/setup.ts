/**
 * Unit project setup: the integration resolver (lib/integrations/resolver.ts) never reaches the database in unit
 * tests. No Admin-saved integrations by default, so the env fallback decides; tests that need saved rows install their
 * own loader with setIntegrationRowsLoader().
 *
 * Imports only the dependency-free slot module: importing the resolver here would load lib/env, lib/db and lib/log
 * before a test file's vi.mock() of them could apply.
 */
import { beforeEach } from "vitest";
import { integrationSlot, invalidateIntegrations } from "@/lib/integrations/slot";

integrationSlot().loader = async () => [];

// Tests stub process.env between cases; a snapshot must never outlive the case that loaded it.
beforeEach(() => invalidateIntegrations());
