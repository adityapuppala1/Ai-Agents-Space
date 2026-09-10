import { InputError } from "../../../core/src/TaskStore.js";
import {
  createExtensionRegistry,
  SIGNATURE_MEANING,
} from "../../../core/src/extensions/registry.js";
import {
  EXTENSION_KINDS,
  MANIFEST_VERSION,
  describePermissions,
} from "../../../core/src/extensions/manifest.js";
import {
  getTemplate,
  validateTemplate,
  CONNECTOR_VOCABULARY,
} from "../../../core/src/workflows/templates/index.js";

/**
 * Extension registry and template sharing (roadmap §16).
 *
 *   GET    /api/extensions                  inventory + trust model
 *   POST   /api/extensions/import-preview   { manifest, workspaceId? }
 *   POST   /api/extensions                  install (workspace opt-in)
 *   PATCH  /api/extensions/:id              stage update / accept / reject / pin
 *   POST   /api/extensions/:id/revoke       { reason }
 *   DELETE /api/extensions/:id              refused while a run is using it
 *   GET    /api/templates/:id/export        secret-stripped shareable template
 *   POST   /api/templates/import-preview    { template } → preview only
 *
 * Register BEFORE routes/workspaces.js (it owns the catch-all /api prefix).
 * `/api/templates/:id/export` and `/api/templates/import-preview` do not
 * collide with routes/workflows.js, which claims only `GET /api/templates`
 * and `GET /api/templates/:id`.
 *
 * No extension is ever loaded or executed here: the registry records what an
 * extension claims and what a workspace allowed. A signature establishes the
 * publisher and integrity, never safety.
 */
export default async function extensionRoutes(ctx) {
  const { method, path, send, body, query, services, actor } = ctx;
  if (!path.startsWith("/api/extensions") && !path.startsWith("/api/templates"))
    return false;

  const registry = () => {
    if (!services.db)
      throw new InputError("Extension registry is not available", 503);
    services.extensions ??= createExtensionRegistry(services);
    return services.extensions;
  };

  /* ------------------------------- templates ------------------------------ */

  const exportMatch = path.match(/^\/api\/templates\/([^/]+)\/export$/);
  if (exportMatch) {
    if (method !== "GET")
      throw new InputError("Use GET to export a template", 405);
    send(
      200,
      registry().exportTemplate(decodeURIComponent(exportMatch[1]), {
        getTemplate,
      }),
    );
    return true;
  }

  if (path === "/api/templates/import-preview") {
    if (method !== "POST")
      throw new InputError("Use POST to preview a template import", 405);
    const payload = await body();
    const document = payload?.template ?? payload?.document ?? payload;
    const result = registry().importTemplate(document, {
      validateTemplate,
      connectorVocabulary: CONNECTOR_VOCABULARY,
    });
    send(200, result);
    return true;
  }

  if (path.startsWith("/api/templates")) return false;

  /* ------------------------------ extensions ------------------------------ */

  if (path === "/api/extensions") {
    if (method === "GET") {
      const workspaceId = query.get("workspace") || null;
      const items = registry()
        .dependencyInventory()
        .filter((entry) =>
          workspaceId ? entry.workspaces.includes(workspaceId) : true,
        );
      send(200, {
        extensions: items,
        kinds: EXTENSION_KINDS,
        manifestVersion: MANIFEST_VERSION,
        signatureMeaning: SIGNATURE_MEANING,
        loadingSupported: false,
        note: "This build records extensions. It does not load or execute them.",
      });
      return true;
    }
    if (method === "POST") {
      const payload = await body();
      send(
        201,
        registry().install({
          manifest: payload?.manifest ?? payload,
          source: payload?.source ?? "local",
          workspaceId: payload?.workspaceId,
          dependencies: payload?.dependencies ?? [],
          actor,
        }),
      );
      return true;
    }
    throw new InputError("Use GET or POST on /api/extensions", 405);
  }

  if (path === "/api/extensions/import-preview") {
    if (method !== "POST")
      throw new InputError("Use POST to preview an extension import", 405);
    const payload = await body();
    send(
      200,
      registry().importPreview({
        manifest: payload?.manifest ?? payload,
        workspaceId: payload?.workspaceId ?? null,
      }),
    );
    return true;
  }

  const revoke = path.match(/^\/api\/extensions\/([^/]+)\/revoke$/);
  if (revoke) {
    if (method !== "POST")
      throw new InputError("Use POST to revoke an extension", 405);
    const payload = await body();
    send(
      200,
      registry().revoke(decodeURIComponent(revoke[1]), {
        reason: payload?.reason ?? "",
        actor,
      }),
    );
    return true;
  }

  const single = path.match(/^\/api\/extensions\/([^/]+)$/);
  if (single) {
    const id = decodeURIComponent(single[1]);
    if (method === "GET") {
      send(200, registry().get(id));
      return true;
    }
    if (method === "PATCH") {
      const payload = (await body()) ?? {};
      const registrar = registry();
      let record = null;
      if (payload.manifest)
        record = registrar.update(id, payload.manifest, { actor });
      if (payload.acceptUpdate)
        record = registrar.acceptUpdate(id, {
          acceptedPermissions: payload.acceptedPermissions === true,
          actor,
        });
      if (payload.rejectUpdate) record = registrar.rejectUpdate(id, { actor });
      if (payload.pin)
        record = registrar.pin(id, String(payload.pin), { actor });
      if (!record)
        throw new InputError(
          "Send { manifest } to stage an update, { acceptUpdate, acceptedPermissions } to apply it, { rejectUpdate } to drop it, or { pin } to pin a version",
        );
      send(200, {
        ...record,
        permissionSummary: describePermissions(record.manifest),
        signatureMeaning: SIGNATURE_MEANING,
      });
      return true;
    }
    if (method === "DELETE") {
      send(200, registry().remove(id, { actor }));
      return true;
    }
    throw new InputError(
      "Use GET, PATCH, or DELETE on /api/extensions/:id",
      405,
    );
  }

  return false;
}
