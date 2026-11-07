"""Run by cron at 07:00: marks tomorrow's bookings as reminded (the SMS gateway reads the same table)."""
import datetime
import os
import sqlite3

db = sqlite3.connect(os.environ.get("CLINIC_DB", os.path.join(os.path.dirname(__file__), "..", "clinic.db")))
tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
db.execute("""UPDATE bookings_booking SET reminder_sent = 1
              WHERE status = 'booked' AND slot_id IN (SELECT id FROM bookings_slot WHERE date(starts_at) = ?)""", (tomorrow,))
db.commit()
