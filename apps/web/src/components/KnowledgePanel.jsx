import React, { useEffect, useState } from "react";
import { Library, RefreshCw, Trash2, Plus, FileText } from "lucide-react";
import { apiFetch, useApi, formatTime, maskPath } from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

const FRESHNESS_TEXT = {
  fresh: "matches its source",
  changed: "source changed since capture",
  missing: "source file is gone",
  unchecked: "not checked",
  "no-source": "no file source",
};

/**
 * Named, versioned knowledge collections for one workspace, with attribution,
 * freshness and deletion.
 *
 * Honest limits shown in the UI:
 *  - freshness is only checkable for items captured from a file inside the
 *    workspace root; everything else is reported as "not checked", never as
 *    fresh;
 *  - deleting an item is a soft delete (it stops being used) unless you purge
 *    it, and the panel says which happened;
 *  - access is recorded per collection, and collections never cross a
 *    workspace boundary.
 *
 * Routes: GET|POST /api/workspaces/:id/knowledge,
 * GET|PATCH|DELETE /api/workspaces/:id/knowledge/:cid,
 * POST /api/workspaces/:id/knowledge/:cid/items,
 * PATCH|DELETE /api/workspaces/:id/knowledge/:cid/items/:itemId,
 * POST /api/workspaces/:id/knowledge/:cid/refresh.
 *
 * @param {{ workspaceId: string, presentation?: boolean }} props
 */
export default function KnowledgePanel({ workspaceId, presentation = false }) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/knowledge`;
  const collections = useApi(workspaceId ? base : null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [newCollection, setNewCollection] = useState(null);
  const [newItem, setNewItem] = useState({
    title: "",
    source: "",
    content: "",
  });

  const list = Array.isArray(collections.data) ? collections.data : [];

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setFreshness(null);
      return undefined;
    }
    let stopped = false;
    apiFetch(`${base}/${encodeURIComponent(selectedId)}`)
      .then((data) => !stopped && setDetail(data))
      .catch((err) => !stopped && setError(err.message));
    return () => {
      stopped = true;
    };
  }, [selectedId, base]);

  const reloadDetail = async () => {
    if (!selectedId) return;
    try {
      setDetail(await apiFetch(`${base}/${encodeURIComponent(selectedId)}`));
    } catch (err) {
      setError(err.message);
    }
  };

  const guard = async (fn) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId)
    return (
      <EmptyState
        compact
        title="Choose a workspace"
        description="Knowledge collections belong to one workspace."
      />
    );
  if (collections.error)
    return (
      <EmptyState
        title="Knowledge collections are unavailable"
        error={collections.error}
        missingRoutes={["GET /api/workspaces/:id/knowledge"]}
      />
    );

  return (
    <section className="as-knowledge" aria-label="Knowledge collections">
      <header className="as-section-head">
        <h3>
          <Library size={14} aria-hidden="true" /> Knowledge
        </h3>
        <button
          type="button"
          className="button"
          onClick={() =>
            setNewCollection({ name: "", description: "", access: "workspace" })
          }
        >
          <Plus size={12} /> New collection
        </button>
      </header>
      <p className="as-muted as-small">
        Collections are named, versioned and scoped to this workspace. Each item
        keeps where it came from and when it was captured, so an agent's context
        can always be traced back to a source.
      </p>

      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}

      {newCollection ? (
        <form
          className="as-card"
          aria-label="Create a knowledge collection"
          onSubmit={(event) => {
            event.preventDefault();
            guard(async () => {
              const created = await apiFetch(base, {
                method: "POST",
                body: newCollection,
              });
              setNewCollection(null);
              collections.reload();
              setSelectedId(created.id);
              setMessage(
                `Created "${created.name}" at version ${created.version}.`,
              );
            });
          }}
        >
          <div className="form-columns">
            <label>
              Name
              <input
                autoFocus
                value={newCollection.name}
                onChange={(event) =>
                  setNewCollection({
                    ...newCollection,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Access
              <select
                value={newCollection.access}
                onChange={(event) =>
                  setNewCollection({
                    ...newCollection,
                    access: event.target.value,
                  })
                }
              >
                <option value="workspace">workspace</option>
                <option value="private">private</option>
              </select>
            </label>
          </div>
          <label>
            Description
            <input
              value={newCollection.description}
              onChange={(event) =>
                setNewCollection({
                  ...newCollection,
                  description: event.target.value,
                })
              }
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setNewCollection(null)}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              Create
            </button>
          </div>
        </form>
      ) : null}

      {list.length === 0 && !collections.loading ? (
        <EmptyState
          compact
          icon={<Library size={20} />}
          title="No knowledge collections yet"
          description="Group the documents and notes an agent should be given in this workspace."
          actions={[
            {
              label: "New collection",
              primary: true,
              onClick: () =>
                setNewCollection({
                  name: "",
                  description: "",
                  access: "workspace",
                }),
            },
          ]}
        />
      ) : null}

      <ul className="as-knowledge-list" role="list">
        {list.map((collection) => (
          <li key={collection.id}>
            <button
              type="button"
              className={`as-knowledge-item ${selectedId === collection.id ? "active" : ""}`}
              aria-expanded={selectedId === collection.id}
              onClick={() =>
                setSelectedId((current) =>
                  current === collection.id ? null : collection.id,
                )
              }
            >
              <strong>{collection.name}</strong>
              <span className="as-tag">v{collection.version}</span>
              <span className="as-tag">{collection.access}</span>
              <span className="as-muted as-small">
                {collection.itemCount ?? 0} item
                {(collection.itemCount ?? 0) === 1 ? "" : "s"} · updated{" "}
                {formatTime(collection.updatedAt)}
              </span>
            </button>

            {selectedId === collection.id && detail ? (
              <div className="as-knowledge-detail">
                {detail.description ? <p>{detail.description}</p> : null}
                <div className="as-row as-wrap">
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        const result = await apiFetch(
                          `${base}/${encodeURIComponent(collection.id)}/refresh`,
                          { method: "POST" },
                        );
                        setFreshness(result);
                        setMessage(
                          `Checked ${result.checked} item(s); ${result.stale} need re-capturing.`,
                        );
                      })
                    }
                  >
                    <RefreshCw size={12} /> Check freshness
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        await apiFetch(
                          `${base}/${encodeURIComponent(collection.id)}`,
                          { method: "DELETE" },
                        );
                        setSelectedId(null);
                        collections.reload();
                        setMessage(
                          `Deleted "${collection.name}". Its items are no longer offered to any run.`,
                        );
                      })
                    }
                  >
                    <Trash2 size={12} /> Delete collection
                  </button>
                </div>

                <ul className="as-knowledge-items" role="list">
                  {(detail.items ?? []).length === 0 ? (
                    <li className="as-muted">No items captured yet.</li>
                  ) : null}
                  {(detail.items ?? []).map((item) => {
                    const check = freshness?.items?.find(
                      (entry) => entry.id === item.id,
                    );
                    return (
                      <li key={item.id} className="as-knowledge-itemrow">
                        <div>
                          <span className="as-row as-wrap">
                            <FileText size={12} aria-hidden="true" />
                            <strong>{item.title}</strong>
                            <span className="as-tag">v{item.version}</span>
                            {check ? (
                              <span
                                className={`as-tag ${check.stale ? "as-tag-warn" : ""}`}
                              >
                                {FRESHNESS_TEXT[check.state] ?? check.state}
                              </span>
                            ) : null}
                          </span>
                          <span className="as-muted as-small">
                            {item.source
                              ? `from ${maskPath(item.source, presentation)}`
                              : "no source recorded"}
                            {item.sourceUrl ? ` · ${item.sourceUrl}` : ""} ·
                            captured {formatTime(item.capturedAt)}
                            {item.freshnessCheckedAt
                              ? ` · last checked ${formatTime(item.freshnessCheckedAt)}`
                              : " · never checked"}
                          </span>
                          {check?.detail ? (
                            <span className="as-muted as-small">
                              {check.detail}
                            </span>
                          ) : null}
                        </div>
                        <span className="as-row">
                          <button
                            type="button"
                            className="icon-button"
                            disabled={busy}
                            aria-label={`Remove ${item.title} from this collection`}
                            title="Soft delete: the item stops being used but stays recorded"
                            onClick={() =>
                              guard(async () => {
                                await apiFetch(
                                  `${base}/${encodeURIComponent(collection.id)}/items/${encodeURIComponent(item.id)}`,
                                  { method: "DELETE" },
                                );
                                await reloadDetail();
                                collections.reload();
                                setMessage(
                                  `"${item.title}" is no longer used. Its record is kept; use purge to remove it entirely.`,
                                );
                              })
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              guard(async () => {
                                await apiFetch(
                                  `${base}/${encodeURIComponent(collection.id)}/items/${encodeURIComponent(item.id)}?purge=1`,
                                  { method: "DELETE" },
                                );
                                await reloadDetail();
                                collections.reload();
                                setMessage(
                                  `"${item.title}" was purged. The content is gone and cannot be recovered.`,
                                );
                              })
                            }
                          >
                            Purge
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <form
                  className="as-knowledge-add"
                  aria-label="Add a knowledge item"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newItem.title.trim()) return;
                    guard(async () => {
                      await apiFetch(
                        `${base}/${encodeURIComponent(collection.id)}/items`,
                        {
                          method: "POST",
                          body: {
                            title: newItem.title.trim(),
                            source: newItem.source.trim() || null,
                            content: newItem.content,
                          },
                        },
                      );
                      setNewItem({ title: "", source: "", content: "" });
                      await reloadDetail();
                      collections.reload();
                      setMessage(
                        "Item captured with its source and timestamp.",
                      );
                    });
                  }}
                >
                  <div className="form-columns">
                    <label>
                      Title
                      <input
                        value={newItem.title}
                        onChange={(event) =>
                          setNewItem({ ...newItem, title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Source file <span className="optional">(optional)</span>
                      <input
                        value={newItem.source}
                        onChange={(event) =>
                          setNewItem({ ...newItem, source: event.target.value })
                        }
                        placeholder="docs/ARCHITECTURE.md"
                      />
                    </label>
                  </div>
                  <label>
                    Content
                    <textarea
                      rows={3}
                      value={newItem.content}
                      onChange={(event) =>
                        setNewItem({ ...newItem, content: event.target.value })
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    className="button"
                    disabled={busy || !newItem.title.trim()}
                  >
                    <Plus size={12} /> Capture item
                  </button>
                  <p className="as-muted as-small">
                    A file source is only re-read for freshness when it sits
                    inside the workspace root and is not a secret path.
                  </p>
                </form>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
