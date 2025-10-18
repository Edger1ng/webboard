# Local Web Dashboard

Lightweight local monitoring dashboard with draggable/resizable widgets, presets, plugin system, Chart.js graphs, and long-term metrics storage in SQLite with automatic retention cleanup.

## Features
- Grid layout with drag/resize (GridStack)
- Per-user layouts and named presets
- Plugin system (Python route + static JS/CSS) with custom widgets
- Chart.js graphs with soft vertical gradients, crosshair, tooltip, optional focus blur
- Background sampler that stores CPU/RAM/network/temperature to SQLite
- Retention-based cleanup of old metrics
- Light/Dark UI themes

## Requirements
- Python 3.10+
- `pip install flask psutil werkzeug`
- Internet access for CDN (or host Chart.js and GridStack locally)

## Quick Start
```bash
git clone <repo-url> local-web-dashboard
cd local-web-dashboard
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt  # or: pip install flask psutil werkzeug
python app.py
```
Open `http://127.0.0.1:5000`. Default admin: `admin` / `admin123`.

## Users
- Login: `/login`, Logout: `/logout`
- Create user (admin):
```bash
curl -s -c cookies.txt -X POST -d "username=admin" -d "password=admin123" http://127.0.0.1:5000/login > /dev/null
curl -s -b cookies.txt -H "Content-Type: application/json"   -d '{"username":"user1","password":"secret123","role":"user"}'   http://127.0.0.1:5000/admin/create-user
```
- List users:
```bash
curl -s -b cookies.txt http://127.0.0.1:5000/admin/list-users
```
- Insert directly into SQLite:
```bash
python -c "from werkzeug.security import generate_password_hash as g; import sqlite3; c=sqlite3.connect('dashboard.db'); c.execute(\"INSERT INTO users(username,password_hash,role) VALUES(?,?,?)\", ('user1', g('secret123'), 'user')); c.commit(); c.close(); print('ok')"
```

## Layouts & Presets
- **Edit** toggles grid editing; drag by header; resize from corner.
- **Save** stores the current user layout.
- **Save Preset** creates a named layout; select from **Presets**; **Delete Preset** removes it.
- Reset a user layout:
```bash
python - <<'PY'
import sqlite3
conn=sqlite3.connect('dashboard.db')
conn.execute("DELETE FROM layouts WHERE user_id=(SELECT id FROM users WHERE username=?)", ("admin",))
conn.commit(); conn.close(); print("layout reset")
PY
```

## Metrics Storage
- Background thread samples every `SAMPLE_INTERVAL_SEC` seconds and writes to table `metrics(ts,cpu,ram,up,down,temp)`.
- Cleanup runs ~every 5 minutes removing rows older than `RETENTION_HOURS` hours.

Config in `app.py`:
```python
SAMPLE_INTERVAL_SEC = 5
RETENTION_HOURS = 168
```

### History API
```
GET /api/metrics?hours=<float>&step=<int>
```
Aggregates by `(ts/step)`. Returns JSON array of `{ts,cpu,ram,up,down,temp}`.

### Runtime Tuning (admin)
```
POST /admin/retention
{"hours": 720, "interval": 5}
```

## Frontend
- Grid: GridStack (`gridstack-all.js`)
- Charts: Chart.js (`chart.umd.min.js`)
- `static/main.js`:
  - live updates from `/api/stats`
  - initial history preload from `/api/metrics`
  - soft vertical gradients, crosshair tooltip, focus blur on active chart

## Plugin System
Directory: `plugins/<name>/`

```
plugins/
  myplugin/
    manifest.json
    plugin.py
    static/
      my.css
      my.js
```

`manifest.json`:
```json
{
  "name": "myplugin",
  "title": "My Plugin",
  "version": "1.0.0",
  "module": "plugin.py",
  "styles": ["my.css"],
  "scripts": ["my.js"],
  "widgets": [{ "id": "my_widget", "title": "My Widget", "minW": 3, "minH": 2 }],
  "min_role": "viewer"
}
```

`plugin.py`:
```python
def register(app, base_url="/plugins/myplugin"):
    @app.route(base_url + "/api/ping")
    def ping():
        return "ok"
```

`static/my.js`:
```javascript
window.PLUGIN_WIDGETS = window.PLUGIN_WIDGETS || [];
window.PLUGIN_WIDGETS.push({
  id: 'my_widget',
  title: 'My Widget',
  minW: 3, minH: 2,
  html: '<div id="hello">Hello</div>',
  mount: (cardNode) => ({ update: (stats) => {} })
});
```

## Project Structure
```
app.py
dashboard.db
templates/
  index.html
static/
  style.css
  main.js
plugins/
  ...
```

## Troubleshooting
1) Tiles do not move/resize: enable **Edit**; ensure `gridstack-all.js` loads.
2) No charts: check console; verify CDN:
   - https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js
   - https://cdn.jsdelivr.net/npm/gridstack@10.3.1/dist/gridstack-all.js
3) MIME/nosniff errors: serve JS/CSS locally from `static/`.
4) `widgetFactory is not defined`: declare before `buildGrid()` and export `window.widgetFactory = widgetFactory`.
5) Bad saved layout: delete the layout row for the user and hard refresh (Ctrl/Cmd+Shift+R).

## License
MIT

