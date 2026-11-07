from django.conf.urls import url

from bookings import views

urlpatterns = [
    url(r"^$", views.calendar, name="calendar"),
    url(r"^slots/(?P<slot_id>\d+)/$", views.slot_detail, name="slot"),
    url(r"^bookings/(?P<booking_id>\d+)/$", views.booking_detail, name="booking"),
    url(r"^bookings/(?P<booking_id>\d+)/cancel/$", views.cancel_booking, name="cancel"),
    url(r"^day/(?P<day>\d{4}-\d{2}-\d{2})/$", views.day_list, name="day"),
    # read every 60 seconds by the reception kiosk (do not change the format)
    url(r"^api/slots\.json$", views.api_slots, name="api_slots"),
    url(r"^api/bookings/(?P<booking_id>\d+)\.json$", views.api_booking, name="api_booking"),
]
