"""Build data/clinic.db: SYNTHETIC data for the Sample Clinic test app (made-up clinic and patients).

The schema comes from the app's own Django migrations (run with Django 3.2, as the clinic would have it);
the rows are generated deterministically. A few slots carry two active bookings: the double-booking bug's
footprint in the data. Usage: python3 make_data.py
"""
import datetime
import os
import random
import sqlite3
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DB = HERE / "data" / "clinic.db"
VENV = ROOT / "var" / "venvs" / "demo-django32"
UV = os.environ.get("GOOSE_UV", "/opt/homebrew/bin/uv")

FIRST = ["Ana", "Ben", "Chloe", "Dev", "Elif", "Femi", "Grace", "Hugo", "Iris", "Jon", "Kemal", "Lena", "Marta", "Nils",
         "Omar", "Priya", "Quinn", "Rosa", "Sami", "Tara", "Uma", "Viktor", "Wen", "Yara", "Zane"]
LAST = ["Abbott", "Brennan", "Castillo", "Dimitrov", "Eze", "Fischer", "Gallo", "Hart", "Ito", "Jansen", "Kaur", "Lund",
        "Moreau", "Novak", "Okafor", "Pereira", "Quist", "Rossi", "Sato", "Tanaka", "Ueda", "Varga", "Walsh", "Young"]
CLINICIANS = [("Dr Maya Lindqvist", "Physiotherapy"), ("Dr Tomas Rey", "Sports injuries"), ("Dr Aisha Bello", "Physiotherapy"),
              ("Sam Oduya", "Massage therapy"), ("Dr Ines Carvalho", "Back pain"), ("Lucas Brandt", "Rehabilitation")]


def django_python():
    py = VENV / "bin" / "python"
    if not py.exists():
        subprocess.run([UV, "venv", "--python", "/usr/bin/python3", str(VENV), "-q"], check=True)
        subprocess.run([UV, "pip", "install", "--python", str(py), "-q", "--only-binary", ":all:",
                        "-r", str(HERE / "repo" / "requirements.txt")], check=True)
    return str(py)


def main():
    DB.parent.mkdir(exist_ok=True)
    DB.unlink(missing_ok=True)
    env = {"PATH": "/usr/bin:/bin", "CLINIC_DB": str(DB), "PYTHONDONTWRITEBYTECODE": "1"}
    subprocess.run([django_python(), "manage.py", "migrate", "-v", "0"], cwd=HERE / "repo", env=env, check=True)
    rnd = random.Random(20261102)
    c = sqlite3.connect(DB)
    c.executemany("INSERT INTO bookings_clinician (id, name, specialty) VALUES (?, ?, ?)",
                  [(i + 1, n, s) for i, (n, s) in enumerate(CLINICIANS)])
    patients = []
    for i in range(160):
        name = f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
        created = datetime.datetime(2025, 1, 6, 9, 0) + datetime.timedelta(days=rnd.randint(0, 600), minutes=rnd.randint(0, 480))
        patients.append((i + 1, name, f"555-01{i:03d}"[:12], f"patient{i + 1}@example.org" if rnd.random() < 0.7 else "",
                         created.strftime("%Y-%m-%d %H:%M:%S")))
    c.executemany("INSERT INTO bookings_patient (id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)", patients)
    slots, bookings = [], []
    day = datetime.date(2026, 10, 5)
    today = datetime.date(2026, 11, 4)
    sid = bid = 0
    while day <= datetime.date(2026, 12, 31):
        if day.weekday() < 5:
            for k in range(4):
                clinician = (day.toordinal() + k) % len(CLINICIANS) + 1
                for half in range(16):
                    sid += 1
                    start = datetime.datetime.combine(day, datetime.time(9, 0)) + datetime.timedelta(minutes=30 * half)
                    slots.append((sid, clinician, start.strftime("%Y-%m-%d %H:%M:%S"), 30))
                    p = 0.6 if day < today else 0.3
                    if rnd.random() < p:
                        bid += 1
                        status = "cancelled" if rnd.random() < 0.08 else "booked"
                        made = start - datetime.timedelta(days=rnd.randint(1, 20), hours=rnd.randint(0, 8))
                        reminded = 1 if day < today and status == "booked" else None
                        bookings.append((bid, sid, rnd.randint(1, len(patients)), status, reminded, made.strftime("%Y-%m-%d %H:%M:%S")))
        day += datetime.timedelta(days=1)
    # the double-booking bug: two receptionists booked the same slot within a minute (the view never re-checks)
    for target in rnd.sample([b for b in bookings if b[3] == "booked"], 7):
        bid += 1
        made = datetime.datetime.strptime(target[5], "%Y-%m-%d %H:%M:%S") + datetime.timedelta(seconds=rnd.randint(5, 50))
        bookings.append((bid, target[1], rnd.randint(1, len(patients)), "booked", target[4], made.strftime("%Y-%m-%d %H:%M:%S")))
    c.executemany("INSERT INTO bookings_slot (id, clinician_id, starts_at, minutes) VALUES (?, ?, ?, ?)", slots)
    c.executemany("INSERT INTO bookings_booking (id, slot_id, patient_id, status, reminder_sent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                  bookings)
    c.commit()
    print(f"{DB}: {len(CLINICIANS)} clinicians, {len(patients)} patients, {len(slots)} slots, {len(bookings)} bookings")


if __name__ == "__main__":
    main()
