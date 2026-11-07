import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
SAMPLES = Path(__file__).resolve().parent / "fixtures" / "samples"
ORDERS = SAMPLES / "flask-orders"          # Flask + sqlite3 JSON order service
WHOLESALE = SAMPLES / "flask-wholesale"    # Flask app-factory API
CLINIC = SAMPLES / "django-clinic"         # Django booking site

# the sample applications carry their own tests; they are inputs to the engine, not tests of it
collect_ignore_glob = ["fixtures/*"]
