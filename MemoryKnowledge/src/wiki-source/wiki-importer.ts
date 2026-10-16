/**
 * WikiImporter — fetch service for scheduled sync of external wikis (called by AutoSyncScheduler).
 *
 * Eligibility (design §5.4): **no per-wiki switch**; wiki sync follows the global switch
 * `KNOWLEDGE_AUTO_SYNC_ENABLED`; participation is decided by "whether a credential row exists" (§4.2,
 * credential row exists == external source). The scheduler already filters on this; this only executes.
 *
 * Sync scope: **the full content of every document is re-fetched**.
 * Generic external sources usually lack a reliable "incremental by update time" API:
 *   - List APIs (most platforms return only direct children, requiring level-by-level expansion) give only titles/hierarchy,
 *     no body, and often no update time
 *   - Bodies can only be fetched one by one
 * So each sync round re-fetches all document bodies and overwrites same-named files,
 * naturally covering all three changes: "added / modified / deleted and recreated".
 *
 * Difference from the initial import: the initial import may select only some documents (pageIds);
 * sync **passes no pageIds** → full.
 */

import { createLogger } from "../logger.js";
import type { IKnowledgeStore } from "../store/types.js";
import type { WikiServiceLike } from "./import-runner.js";
import { runImport } from "./import-runner.js";
import type { WikiSourceRegistry } from "./registry.js";
import type { WikiImporter } from "../store/auto-sync-scheduler.js";

const log = createLogger("wiki-importer");

export interface WikiImporterDeps {
  registry: WikiSourceRegistry;
  wikiService: WikiServiceLike;
  /** Fetch the wiki row to get source_type (provider id) and source_url. */
  store: Pick<IKnowledgeStore, "getWikiById">;
}

export function createWikiImporter(deps: WikiImporterDeps): WikiImporter {
  return {
    async run(serviceId, teamId, wikiId, cred): Promise<number> {
      const row = deps.store.getWikiById(serviceId, wikiId);
      if (!row) {
        log.warn(`[wiki-sync] wiki ${wikiId} not found, skip`);
        return 0;
      }

      const providerId = row.source_type;
      const sourceUrl = row.source_url;
      if (!providerId || !sourceUrl) {
        // Manually uploaded wikis should not be candidates (the scheduler filters by credential row); this is a defensive check
        log.debug(`[wiki-sync] wiki ${wikiId} has no external source, skip`);
        return 0;
      }

      if (!deps.registry.get(providerId)) {
        // Provider not enabled in this deployment (WIKI_SOURCE_ENABLED does not include this id)
        log.warn(`[wiki-sync] wiki ${wikiId} provider '${providerId}' not enabled, skip`);
        return 0;
      }

      const result = await runImport({
        registry: deps.registry,
        wikiService: deps.wikiService,
        providerId,
        secret: cred.secret,
        username: cred.username,
        serviceId,
        teamId,
        wikiId,
        sourceUrl,
        // No pageIds → fully re-fetch all document bodies (including added/modified)
      });

      if (result.failed.length > 0) {
        // Partial failure does not throw: successful documents are already on disk, and throwing would roll back the whole round
        log.warn(
          `[wiki-sync] wiki ${wikiId} partially synced: ${result.imported} ok, ${result.failed.length} failed`,
        );
      }
      if (result.warnings.length > 0) {
        log.debug(`[wiki-sync] wiki ${wikiId} warnings: ${result.warnings.join("; ")}`);
      }

      return result.imported;
    },
  };
}
