import React, { useState } from "react";
import { Layers, Sparkles } from "lucide-react";
import { apiFetch, useApi, providerLabel } from "../hooks/useApi.js";
import Dialog from "./Dialog.jsx";

/**
 * Workflow template gallery (GET /api/templates) with an inputs form built
 * from each template's `sampleInputs` keys. Instantiation posts to
 * `POST /api/workspaces/:id/workflows { templateId, inputs }`.
 * @param {{ workspaceId: string, onInstantiated?: (workflow: any) => void }} props
 */
export default function TemplateGallery({ workspaceId, onInstantiated }) {
  const templates = useApi("/templates");
  const [selected, setSelected] = useState(null);
  const [inputs, setInputs] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const list = Array.isArray(templates.data)
    ? templates.data
    : (templates.data?.templates ?? []);
  const domains = [...new Set(list.map((t) => t.domain ?? "general"))].sort();

  const open = (template) => {
    setSelected(template);
    setInputs({ ...(template.sampleInputs ?? {}) });
    setError("");
  };
  const instantiate = async () => {
    setBusy(true);
    setError("");
    try {
      const workflow = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/workflows`,
        {
          method: "POST",
          body: { templateId: selected.id, inputs },
        },
      );
      onInstantiated?.(workflow);
      setFeedback(
        `Created ${selected.steps?.length ?? ""} task(s) from "${selected.name}".`,
      );
      setSelected(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="as-gallery" aria-label="Workflow templates">
      <header className="as-section-head">
        <h3>
          <Layers size={14} aria-hidden="true" /> Templates
        </h3>
        <span className="as-muted">{list.length} available</span>
      </header>
      {templates.error ? (
        <div className="form-error" role="alert">
          {templates.error.message}
        </div>
      ) : null}
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {domains.map((domain) => (
        <div key={domain} className="as-gallery-group">
          <h4>{domain}</h4>
          <div className="as-gallery-grid">
            {list
              .filter((t) => (t.domain ?? "general") === domain)
              .map((template) => (
                <article key={template.id} className="as-card as-template">
                  <strong>{template.name}</strong>
                  <p className="as-muted">{template.description}</p>
                  <p className="as-muted as-small">
                    {template.steps?.length ?? 0} steps · roles:{" "}
                    {(template.roles ?? []).join(", ") || "any"}
                    {template.priority ? ` · ${template.priority}` : ""}
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => open(template)}
                    aria-label={`Use template ${template.name}`}
                  >
                    <Sparkles size={12} /> Use
                  </button>
                </article>
              ))}
          </div>
        </div>
      ))}
      {selected ? (
        <Dialog
          title={`Use "${selected.name}"`}
          onClose={() => setSelected(null)}
          wide
        >
          <p className="modal-intro">{selected.description}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              instantiate();
            }}
          >
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
            {Object.keys(inputs).length === 0 ? (
              <p className="as-muted">This template needs no inputs.</p>
            ) : null}
            {Object.keys(inputs).map((key, index) => (
              <label key={key}>
                {key}
                {String(inputs[key] ?? "").length > 60 ? (
                  <textarea
                    rows={3}
                    value={inputs[key] ?? ""}
                    onChange={(e) =>
                      setInputs({ ...inputs, [key]: e.target.value })
                    }
                    data-autofocus={index === 0 ? true : undefined}
                  />
                ) : (
                  <input
                    value={inputs[key] ?? ""}
                    onChange={(e) =>
                      setInputs({ ...inputs, [key]: e.target.value })
                    }
                    data-autofocus={index === 0 ? true : undefined}
                  />
                )}
              </label>
            ))}
            <ol className="as-steps">
              {(selected.steps ?? []).map((step) => (
                <li key={step.key}>
                  <strong>{step.title}</strong>{" "}
                  <span className="as-muted">
                    {step.role}
                    {step.provider ? ` · ${providerLabel(step.provider)}` : ""}
                    {step.dependsOn?.length
                      ? ` · after ${step.dependsOn.join(", ")}`
                      : ""}
                  </span>
                </li>
              ))}
            </ol>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                Create tasks
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
