import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", None)
    SESSION_COOKIE_SECURE = os.environ.get("FLASK_SESSION_COOKIE_SECURE", "false").lower() == "true"
    SESSION_COOKIE_SAMESITE = os.environ.get("FLASK_SESSION_COOKIE_SAMESITE", "Lax")
    SESSION_COOKIE_HTTPONLY = True
    WTF_CSRF_TIME_LIMIT = None
    WTF_CSRF_CHECK_DEFAULT = False

def load_from_env(app):
    app.config.from_object(Config)
    if not app.config.get("SECRET_KEY"):
        raise RuntimeError("FLASK_SECRET_KEY is not set")

