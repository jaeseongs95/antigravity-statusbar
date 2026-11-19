---
name: statusbar-addon
description: "Attach, enable/disable, remove, or list buttons on the Antigravity Statusbar using the standard StatusbarAddon.v1 interface. Use whenever the user asks an agent to add or remove a button on the statusbar (e.g. '상태바에 OO 버튼 붙여줘', '상태바에서 OO 버튼 빼줘')."
---

# Statusbar Add-on Standard Interface (`StatusbarAddon.v1`)

When the user asks you to attach, toggle, or remove a button on the Antigravity Statusbar, **never** hand-edit `statusbar_autoinject.js` or core UI files. Use the standard `StatusbarAddon.v1` interface below. Every attached add-on is automatically bridged into the Statusbar Settings (`⚙` → **연결된 애드온 관리 / Attached Add-ons**) where the user can toggle it ON/OFF or remove it at any time.

## 1. Agent CLI (Persistent Command Add-ons)

Run from the installed plugin directory (`~/.gemini/config/plugins/antigravity-statusbar`):

- **List attached add-ons**:
  ```bash
  node ~/.gemini/config/plugins/antigravity-statusbar/scripts/statusbar-addon.mjs list
  ```
- **Attach (or update) a button**:
  ```bash
  node ~/.gemini/config/plugins/antigravity-statusbar/scripts/statusbar-addon.mjs add \
    --id plan \
    --label plan \
    --command "/plan" \
    --description "Start planning mode" \
    --order 100 \
    --source agent
  ```
- **Enable / Disable a button**:
  ```bash
  node ~/.gemini/config/plugins/antigravity-statusbar/scripts/statusbar-addon.mjs toggle --id plan --enabled false
  ```
- **Remove a button**:
  ```bash
  node ~/.gemini/config/plugins/antigravity-statusbar/scripts/statusbar-addon.mjs remove --id plan
  ```

### Standard `StatusbarAddon.v1` Schema
| Field | Type | Constraints |
| --- | --- | --- |
| `id` | `string` | Required, `/^[A-Za-z0-9_-]{1,48}$/` |
| `label` | `string` | Required, 1–24 chars (displayed on button) |
| `command` | `string` | Required (for persisted addons), 1–500 chars (slash command or prompt) |
| `description` | `string` | Optional, up to 120 chars (tooltip & Settings detail) |
| `order` | `number` | Optional, `-999..999` (default `100`) |
| `enabled` | `boolean` | Optional (default `true`) |
| `source` | `string` | `'agent' \| 'plugin' \| 'user'` (default `'agent'`) |

## 2. Runtime Plugin Bridge (`window.statusbarAddons`)

External UI plugins running in the renderer can attach live interactive buttons without touching Sidecar credentials:

```js
window.statusbarAddons?.register({
  id: 'my-plugin-toggle',
  label: 'MCP',
  description: 'Toggle MCP panel',
  source: 'plugin',
  order: 90,
  onClick: ({ sessionId }) => {
    // plugin action
  },
});

// Remove later:
window.statusbarAddons?.unregister('my-plugin-toggle');
```

All runtime-registered add-ons automatically appear in the Statusbar Settings (`⚙`) bridge, where the user can toggle them ON/OFF (persisted across restarts) or remove them.
