# Portable Visual Presets Design

## Purpose

Let a workspace owner export the visual presentation of an office and import
it into another workspace without carrying tasks, run history, provider
credentials, workspace paths, policies, or user data. A preset gives a team a
repeatable visual language for a development studio, operations centre, or
other supported office environment.

## Scope

This slice adds a data-only visual preset format, local API endpoints, and a
workspace settings flow to export, preview, and apply a preset. It uses the
five built-in office themes already rendered by the Three.js scene.

It does not load executable extensions, remote assets, arbitrary geometry, or
new theme JavaScript. It does not change a workspace's tasks, agents, runs,
connections, policy, root path, or provider settings.

## Preset document

The document has a fixed version and only whitelisted visual fields:

```json
{
  "kind": "agent-space-visual-preset",
  "version": 1,
  "name": "Midnight incident room",
  "theme": "midnight",
  "settings": {
    "graphics": "medium",
    "labelDensity": "active",
    "avatarDetail": "medium",
    "lighting": "focused",
    "ambientSound": false
  }
}
```

`name` is a display label under 80 characters. `theme` must be one of the
server-supported themes. Every setting is optional; omitted values leave the
target workspace's current setting unchanged. Unknown top-level keys and
unknown setting keys are rejected rather than ignored, which makes the format
auditable and prevents a future field from being imported silently.

## Storage and API

The workspace's existing `theme` column stores `theme`. Visual UI settings are
stored in the existing workspace settings service under explicit `ui.office.*`
keys. The server adds three endpoints:

| Route | Behaviour |
|---|---|
| `GET /api/workspaces/:id/visual-preset` | Returns a portable preset derived from the workspace theme and saved office settings. |
| `POST /api/workspaces/:id/visual-preset/preview` | Validates a submitted document and returns the normalized preset plus a change list. Does not write. |
| `POST /api/workspaces/:id/visual-preset/apply` | Validates, writes only allowed visual fields, audits the apply, and returns the normalized preset. |

The server keeps the workspace route responsible for authorization and
broadcast. The new pure core module validates and normalizes documents so it
can be tested without HTTP or React.

## User experience

Settings gains a “Visual preset” row. “Export preset” downloads the generated
JSON. “Import preset” accepts a local JSON file, shows a preview that names
the theme and each changed visual setting, then exposes an explicit “Apply
preset” action. A failed parse or validation error names the field to fix.

The office preview stays honest: importing a visual preset changes only how
the room is drawn. It never suggests that provider runs, agent activity, or
workspace content have moved.

## Data flow

```text
Settings UI -> preview endpoint -> normalized preset + change list
Settings UI -> apply endpoint -> workspace theme + ui.office settings
WebSocket snapshot -> existing Office props -> Three.js rebuilds decoration
```

## Error handling

- Non-object JSON, unsupported version, unsupported theme, invalid value, and
  unknown keys return HTTP 400 with the exact field name.
- Preview has no side effect.
- Apply writes within one database transaction. Validation happens before any
  write.
- A browser file read error stays in the UI and does not call the server.

## Testing

- Unit tests cover strict validation, normalization, export from settings, and
  a diff that lists only changed visual fields.
- Integration tests cover preview without writes, apply writing only visual
  fields, and rejection of policy/provider/task fields.
- Browser coverage imports a fixture preset, confirms the preview, applies it,
  and sees the theme selector change after reload.

## Constraints

- Node.js built-ins only on the server; no new runtime dependencies.
- Maintain the existing five theme identifiers: `studio`, `operations`,
  `garden`, `midnight`, `sandstone`.
- No remote URLs, executable code, credentials, paths, agents, tasks, runs,
  or policy may be included in a visual preset.
- Preserve the existing reduced-motion, graphics, and presentation behaviour.
