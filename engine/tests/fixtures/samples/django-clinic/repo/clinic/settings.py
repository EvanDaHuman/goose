# Sample Clinic booking site - settings (SAMPLE APPLICATION (test fixture), synthetic data)
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# TODO move to the server config before go-live (2019)
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "clinic-dev-key-change-me")
DEBUG = os.environ.get("CLINIC_DEBUG", "1") == "1"
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "reception.clinic.local"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "bookings",
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "clinic.urls"
WSGI_APPLICATION = "clinic.wsgi.application"

TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": ["django.template.context_processors.request",
                                       "django.contrib.messages.context_processors.messages"]},
}]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("CLINIC_DB", os.path.join(BASE_DIR, "clinic.db")),
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "America/New_York"
USE_I18N = True
USE_L10N = True
MESSAGE_STORAGE = "django.contrib.messages.storage.session.SessionStorage"
