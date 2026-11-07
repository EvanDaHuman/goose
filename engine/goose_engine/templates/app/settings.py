"""Configuration from environment variables. Nothing secret is stored in the code."""
import os
from zoneinfo import ZoneInfo


class Settings:
    def __init__(self):
        self.database_url = os.environ.get("DATABASE_URL", "postgresql://localhost/__APP_SLUG__")
        self.business_timezone = os.environ.get("BUSINESS_TIMEZONE", "__TIMEZONE__")
        self.datetime_format = os.environ.get("DATETIME_FORMAT", "__DATETIME_FORMAT__")
        self.pool_min = int(os.environ.get("DB_POOL_MIN", "1"))
        self.pool_max = int(os.environ.get("DB_POOL_MAX", "10"))
        self.zone = ZoneInfo(self.business_timezone)


settings = Settings()

# The shop's own clock. The old code used datetime.now(), which is only right while the server
# clock is set to shop time; the upgraded code always asks for shop time explicitly.
BUSINESS_TZ = settings.zone
