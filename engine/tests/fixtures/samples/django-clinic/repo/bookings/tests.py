import datetime

from django.test import TestCase

from .models import Booking, Clinician, Slot


class BookingTests(TestCase):
    def setUp(self):
        c = Clinician.objects.create(name="Dr Test", specialty="Physiotherapy")
        self.slot = Slot.objects.create(clinician=c, starts_at=datetime.datetime(2026, 11, 9, 9, 0))

    def test_calendar_lists_slot(self):
        r = self.client.get("/?start=2026-11-09")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "Dr Test")

    def test_booking_a_slot(self):
        r = self.client.post("/slots/%d/" % self.slot.id, {"name": "Ann Lee", "phone": "555-0101"})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(Booking.objects.count(), 1)
