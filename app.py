import json
import time
import pathlib
import importlib.util
import sqlite3
import secrets
import psutil
import threading
from datetime import timedelta
from flask import Flask, jsonify, render_template, request, redirect, url_for, session, abort, Blueprint
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = pathlib.Path(__file__).parent
DB_PATH = BASE_DIR / "dashboard.db"

SAMPLE_INTERVAL_SEC = 5
RETENTION_HOURS = 168

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(days=14)

plugins_dir = BASE_DIR / "plugins"
_loaded_plugins = []

_last_net = None

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = db()
    conn.execute("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('viewer','user','admin'))
    )""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS layouts(
      user_id INTEGER NOT NULL,
      layout_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS presets(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      layout_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS metrics(
      ts INTEGER NOT NULL,
      cpu REAL,
      ram REAL,
      up REAL,
      down REAL,
      temp REAL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts)")
    conn.commit()
    conn.close()

def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    conn = db()
    row = conn.execute("SELECT id,username,role FROM users WHERE id=?", (uid,)).fetchone()
    conn.close()
    if not row:
        session.clear()
        return None
    return dict(row)

def require_auth(role=None):
    u = current_user()
    if not u:
        abort(401)
    if role:
        ranks = {"viewer":0,"user":1,"admin":2}
        if ranks[u["role"]] < ranks[role]:
            abort(403)
    return u

def net_speed_mbps():
    global _last_net
    now = time.time()
    io = psutil.net_io_counters()
    sent = io.bytes_sent
    recv = io.bytes_recv
    if _last_net is None:
        _last_net = (now, sent, recv)
        return 0.0, 0.0
    ts_prev, sent_prev, recv_prev = _last_net
    dt = max(now - ts_prev, 1e-6)
    up_bps = (sent - sent_prev) / dt
    down_bps = (recv - recv_prev) / dt
    _last_net = (now, sent, recv)
    return (up_bps * 8 / 1e6, down_bps * 8 / 1e6)

def get_temperatures():
    try:
        temps = psutil.sensors_temperatures(fahrenheit=False)
        values = []
        for _, entries in temps.items():
            for e in entries:
                if e.current is not None:
                    values.append(e.current)
        if values:
            return sum(values) / len(values)
    except Exception:
        pass
    return None

def sample_metrics_once():
    cpu_total = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    up_mbps, down_mbps = net_speed_mbps()
    temp_c = get_temperatures()
    conn = db()
    conn.execute(
        "INSERT INTO metrics(ts,cpu,ram,up,down,temp) VALUES(?,?,?,?,?,?)",
        (int(time.time()), float(cpu_total), float(vm.percent), float(up_mbps), float(down_mbps), None if temp_c is None else float(temp_c))
    )
    conn.commit()
    conn.close()

def cleanup_old_metrics():
    cutoff = int(time.time()) - int(RETENTION_HOURS * 3600)
    conn = db()
    conn.execute("DELETE FROM metrics WHERE ts < ?", (cutoff,))
    conn.commit()
    conn.close()

def sampler_loop():
    t_next = 0
    last_cleanup = 0
    while True:
        now = time.time()
        if now >= t_next:
            sample_metrics_once()
            t_next = now + SAMPLE_INTERVAL_SEC
        if now - last_cleanup >= 300:
            cleanup_old_metrics()
            last_cleanup = now
        time.sleep(0.2)

@app.before_request
def sess():
    session.permanent = True

@app.route("/login", methods=["GET","POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username","").strip()
        password = request.form.get("password","")
        conn = db()
        row = conn.execute("SELECT id,password_hash FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        if row and check_password_hash(row["password_hash"], password):
            session["uid"] = row["id"]
            return redirect(url_for("index"))
        return render_template("login.html", error="Invalid credentials")
    if current_user():
        return redirect(url_for("index"))
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

@app.route("/")
def index():
    if not current_user():
        return redirect(url_for("login"))
    return render_template("index.html")

@app.route("/api/me")
def api_me():
    u = current_user()
    if not u:
        return jsonify({"auth": False})
    return jsonify({"auth": True, "user": u})

@app.route("/api/stats")
def api_stats():
    require_auth("viewer")
    cpu_total = psutil.cpu_percent(interval=None)
    cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("/")
    up_mbps, down_mbps = net_speed_mbps()
    temp_c = get_temperatures()
    return jsonify({
        "ts": time.time(),
        "cpu": {"total": cpu_total, "per_core": cpu_per_core},
        "ram": {"percent": vm.percent, "used": vm.used, "total": vm.total},
        "disk": {"percent": du.percent},
        "net": {"up_mbps": up_mbps, "down_mbps": down_mbps},
        "temperature_c": temp_c
    })

@app.route("/api/metrics")
def api_metrics():
    require_auth("viewer")
    try:
        hours = float(request.args.get("hours", 6))
    except Exception:
        hours = 6.0
    try:
        step = int(request.args.get("step", SAMPLE_INTERVAL_SEC))
    except Exception:
        step = SAMPLE_INTERVAL_SEC
    if step < 1:
        step = 1
    since = int(time.time() - hours * 3600)
    conn = db()
    rows = conn.execute(
        "SELECT (ts / ?) AS b, MIN(ts) AS ts, AVG(cpu) AS cpu, AVG(ram) AS ram, AVG(up) AS up, AVG(down) AS down, AVG(temp) AS temp FROM metrics WHERE ts >= ? GROUP BY b ORDER BY b",
        (step, since)
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        out.append({
            "ts": int(r["ts"]) if r["ts"] is not None else None,
            "cpu": float(r["cpu"]) if r["cpu"] is not None else None,
            "ram": float(r["ram"]) if r["ram"] is not None else None,
            "up": float(r["up"]) if r["up"] is not None else None,
            "down": float(r["down"]) if r["down"] is not None else None,
            "temp": float(r["temp"]) if r["temp"] is not None else None
        })
    return jsonify(out)

@app.route("/admin/retention", methods=["POST"])
def admin_retention():
    require_auth("admin")
    data = request.get_json(force=True)
    hours = int(data.get("hours", RETENTION_HOURS))
    interval = int(data.get("interval", SAMPLE_INTERVAL_SEC))
    globals()["RETENTION_HOURS"] = max(1, hours)
    globals()["SAMPLE_INTERVAL_SEC"] = max(1, interval)
    return jsonify({"ok": True, "retention_hours": RETENTION_HOURS, "interval_sec": SAMPLE_INTERVAL_SEC})

@app.route("/api/processes")
def api_processes():
    require_auth("viewer")
    top = int(request.args.get("top", 5))
    procs = []
    for p in psutil.process_iter(attrs=["pid", "name", "username"]):
        try:
            cpu = p.cpu_percent(interval=0.0)
            mem = p.memory_percent()
            procs.append({"pid": p.info["pid"], "name": p.info["name"], "user": p.info.get("username"), "cpu": cpu, "mem": mem})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: (x["cpu"], x["mem"]), reverse=True)
    return jsonify(procs[:top])

@app.route("/api/layout", methods=["GET","POST"])
def api_layout():
    u = require_auth("viewer")
    conn = db()
    if request.method == "GET":
        row = conn.execute("SELECT layout_json FROM layouts WHERE user_id=?", (u["id"],)).fetchone()
        conn.close()
        if row:
            return jsonify(json.loads(row["layout_json"]))
        default_layout = [
            {"id":"card_cpu","x":0,"y":0,"w":6,"h":4},
            {"id":"card_ram","x":6,"y":0,"w":6,"h":4},
            {"id":"card_net","x":0,"y":4,"w":6,"h":4},
            {"id":"card_procs","x":6,"y":4,"w":6,"h":4}
        ]
        return jsonify(default_layout)
    require_auth("user")
    payload = request.get_json(force=True)
    conn.execute("INSERT INTO layouts(user_id,layout_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET layout_json=excluded.layout_json, updated_at=excluded.updated_at",
                 (u["id"], json.dumps(payload), int(time.time())))
    conn.commit()
    conn.close()
    return jsonify({"ok":True})

@app.route("/api/presets", methods=["GET","POST","DELETE"])
def api_presets():
    u = require_auth("user")
    conn = db()
    if request.method == "GET":
        rows = conn.execute("SELECT id,name,layout_json FROM presets WHERE user_id=? ORDER BY id DESC", (u["id"],)).fetchall()
        conn.close()
        return jsonify([{"id":r["id"],"name":r["name"],"layout":json.loads(r["layout_json"])} for r in rows])
    if request.method == "POST":
        data = request.get_json(force=True)
        name = data.get("name","Preset")
        layout = data.get("layout",[])
        conn.execute("INSERT INTO presets(user_id,name,layout_json,created_at) VALUES(?,?,?,?)",
                     (u["id"], name, json.dumps(layout), int(time.time())))
        conn.commit()
        conn.close()
        return jsonify({"ok":True})
    pid = int(request.args.get("id","0"))
    conn.execute("DELETE FROM presets WHERE id=? AND user_id=?", (pid, u["id"]))
    conn.commit()
    conn.close()
    return jsonify({"ok":True})

@app.route("/api/plugins")
def api_plugins():
    u = require_auth("viewer")
    ranks = {"viewer":0,"user":1,"admin":2}
    r = ranks[u["role"]]
    out = []
    for p in _loaded_plugins:
        need = p.get("min_role","viewer")
        if r >= ranks[need]:
            out.append({
                "name": p["name"],
                "title": p.get("title", p["name"]),
                "version": p.get("version", "0.0.0"),
                "scripts": p.get("scripts", []),
                "styles": p.get("styles", []),
                "widgets": p.get("widgets", [])
            })
    return jsonify(out)

def load_plugins():
    if not plugins_dir.exists():
        return
    for manifest_path in plugins_dir.glob("*/manifest.json"):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        name = manifest.get("name")
        module_rel = manifest.get("module", "plugin.py")
        static_dir = manifest_path.parent / "static"
        if static_dir.exists():
            bp = Blueprint(f"plugin_{name}_static", __name__, static_folder=str(static_dir), url_prefix=f"/plugins/{name}/static")
            app.register_blueprint(bp)
        module_path = manifest_path.parent / module_rel
        if module_path.exists():
            spec = importlib.util.spec_from_file_location(f"plugins.{name}", str(module_path))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if hasattr(module, "register"):
                module.register(app, base_url=f"/plugins/{name}")
        if "scripts" in manifest:
            manifest["scripts"] = [f"/plugins/{name}/static/{s}" for s in manifest["scripts"]]
        if "styles" in manifest:
            manifest["styles"] = [f"/plugins/{name}/static/{s}" for s in manifest["styles"]]
        if "widgets" not in manifest:
            manifest["widgets"] = []
        if "min_role" not in manifest:
            manifest["min_role"] = "viewer"
        manifest["name"] = name
        _loaded_plugins.append(manifest)

@app.route("/admin/create-user", methods=["POST"])
def admin_create_user():
    require_auth("admin")
    data = request.get_json(force=True)
    username = data.get("username","").strip()
    password = data.get("password","")
    role = data.get("role","user")
    if role not in ("viewer","user","admin"):
        abort(400)
    ph = generate_password_hash(password)
    conn = db()
    try:
        conn.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)", (username,ph,role))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        abort(409)
    conn.close()
    return jsonify({"ok":True})

@app.route("/admin/list-users")
def admin_list_users():
    require_auth("admin")
    conn = db()
    rows = conn.execute("SELECT id,username,role FROM users ORDER BY id").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

if __name__ == "__main__":
    init_db()
    load_plugins()
    conn = db()
    exists = conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
    if not exists:
        conn.execute("INSERT OR IGNORE INTO users(username,password_hash,role) VALUES(?,?,?)",
                     ("admin", generate_password_hash("admin123"), "admin"))
        conn.commit()
    conn.close()
    th = threading.Thread(target=sampler_loop, daemon=True)
    th.start()
    app.run(debug=True, host="127.0.0.1", port=5000, use_reloader=False)
