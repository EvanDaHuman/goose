from django.db import models
from django.utils.translation import ugettext_lazy as _


class Clinician(models.Model):
    name = models.CharField(_("name"), max_length=80)
    specialty = models.CharField(_("specialty"), max_length=80)

    def __str__(self):
        return self.name


class Patient(models.Model):
    name = models.CharField(_("name"), max_length=120)
    phone = models.CharField(_("phone"), max_length=30)
    email = models.EmailField(_("email"), blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Slot(models.Model):
    clinician = models.ForeignKey(Clinician, on_delete=models.CASCADE, related_name="slots")
    starts_at = models.DateTimeField(_("starts at"))
    minutes = models.PositiveSmallIntegerField(default=30)

    class Meta:
        ordering = ["starts_at", "id"]

    def is_free(self):
        return not self.bookings.filter(status="booked").exists()


class Booking(models.Model):
    STATUS_CHOICES = [("booked", _("Booked")), ("cancelled", _("Cancelled"))]
    slot = models.ForeignKey(Slot, on_delete=models.CASCADE, related_name="bookings")
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="bookings")
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default="booked")
    # set by the reminder script (scripts/send_reminders.py, run by cron at 7am)
    reminder_sent = models.NullBooleanField()
    created_at = models.DateTimeField(auto_now_add=True)
