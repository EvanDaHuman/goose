# Sample Clinic booking site

> SAMPLE APPLICATION (test fixture) - a made-up physiotherapy clinic with synthetic patients. Not a real business.

Reception staff book patients into clinicians' 30-minute slots. The reception kiosk polls `/api/slots.json`
every minute, and `scripts/send_reminders.py` runs from cron each morning against the same SQLite file.

    pip install -r requirements.txt
    CLINIC_DB=clinic.db python manage.py migrate
    python manage.py runserver

Written in 2019 for Django 2.2, moved to 3.2 in 2021. Nobody has touched it since.
