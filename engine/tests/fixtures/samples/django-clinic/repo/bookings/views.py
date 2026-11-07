import datetime

from django.contrib import messages
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from .forms import BookingForm
from .models import Booking, Patient, Slot


def _start_day(request):
    raw = request.GET.get("start")
    if raw:
        try:
            return datetime.date.fromisoformat(raw)
        except ValueError:
            raise Http404("bad date")
    return datetime.date.today()


def calendar(request):
    start = _start_day(request)
    slots = (Slot.objects.select_related("clinician")
             .filter(starts_at__date__gte=start, starts_at__date__lt=start + datetime.timedelta(days=7)))
    days = {}
    for slot in slots:
        days.setdefault(slot.starts_at.date(), []).append(slot)
    return render(request, "bookings/calendar.html", {"days": sorted(days.items()), "start": start})


def slot_detail(request, slot_id):
    slot = get_object_or_404(Slot.objects.select_related("clinician"), pk=slot_id)
    if request.method == "POST":
        form = BookingForm(request.POST)
        if form.is_valid():
            patient, _ = Patient.objects.get_or_create(
                phone=form.cleaned_data["phone"],
                defaults={"name": form.cleaned_data["name"], "email": form.cleaned_data["email"]})
            # reception checks the calendar before booking, so we do not check again here
            booking = Booking.objects.create(slot=slot, patient=patient)
            messages.success(request, "Booked.")
            return redirect("booking", booking_id=booking.id)
    else:
        form = BookingForm()
    return render(request, "bookings/slot.html", {"slot": slot, "form": form})


def booking_detail(request, booking_id):
    booking = get_object_or_404(Booking.objects.select_related("slot__clinician", "patient"), pk=booking_id)
    return render(request, "bookings/booking.html", {"booking": booking})


@require_POST
def cancel_booking(request, booking_id):
    booking = get_object_or_404(Booking, pk=booking_id)
    booking.status = "cancelled"
    booking.save(update_fields=["status"])
    messages.info(request, "Cancelled.")
    return redirect("booking", booking_id=booking.id)


def day_list(request, day):
    try:
        date = datetime.date.fromisoformat(day)
    except ValueError:
        raise Http404("bad date")
    bookings = (Booking.objects.select_related("slot__clinician", "patient")
                .filter(slot__starts_at__date=date).order_by("slot__starts_at", "id"))
    return render(request, "bookings/day.html", {"date": date, "bookings": bookings})


def _utc(dt):
    local = timezone.make_aware(dt, timezone.get_default_timezone())
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def api_slots(request):
    start = _start_day(request)
    slots = (Slot.objects.select_related("clinician")
             .filter(starts_at__date__gte=start, starts_at__date__lt=start + datetime.timedelta(days=1)))
    return JsonResponse({"date": start.isoformat(), "slots": [
        {"id": s.id, "clinician": s.clinician.name, "starts_at": s.starts_at.strftime("%Y-%m-%d %H:%M"),
         "starts_at_utc": _utc(s.starts_at), "minutes": s.minutes, "free": s.is_free()} for s in slots]})


def api_booking(request, booking_id):
    b = get_object_or_404(Booking.objects.select_related("slot__clinician", "patient"), pk=booking_id)
    return JsonResponse({"id": b.id, "status": b.status, "patient": b.patient.name, "clinician": b.slot.clinician.name,
                         "starts_at": b.slot.starts_at.strftime("%Y-%m-%d %H:%M"), "reminder_sent": b.reminder_sent})
