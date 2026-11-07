from django import forms


class BookingForm(forms.Form):
    name = forms.CharField(max_length=120)
    phone = forms.CharField(max_length=30)
    email = forms.EmailField(required=False)
