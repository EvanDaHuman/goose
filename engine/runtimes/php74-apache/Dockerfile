# Goose runtime for SuiteCRM 7.10 and 7.11 copies (inspection, recording the original behaviour).
# SuiteCRM 7.11.x supports PHP up to 7.4 (from 7.11.19) and MariaDB up to 10.3 (docs.suitecrm.com/admin/compatibility-matrix/).
# PHP 7.4 is end-of-life; Goose runs it only inside the local Linux VM, on copies, bound to 127.0.0.1.
FROM php:7.4.33-apache@sha256:c9d7e608f73832673479770d66aacc8100011ec751d1905ff63fae3fe2e0ca6d

ARG APP_UID=502
ARG APP_GID=20

# Debian 11 (bullseye) packages now live on archive.debian.org; the image is from November 2022.
RUN set -eux; \
    printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends libpng-dev libjpeg62-turbo-dev libfreetype6-dev libzip-dev libicu-dev libc-client-dev libkrb5-dev unzip mariadb-client; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-configure imap --with-kerberos --with-imap-ssl; \
    docker-php-ext-install -j"$(nproc)" mysqli pdo_mysql gd zip imap intl bcmath opcache; \
    a2enmod rewrite headers; \
    rm -rf /var/lib/apt/lists/*

# Composer 1.10.27, the last 1.x release: SuiteCRM 7.11's composer.lock includes wikimedia/composer-merge-plugin 1.4.1,
# which only supports Composer 1. Installs the exact versions pinned in composer.lock.
COPY --from=composer:1.10.27@sha256:dbc308a7af43fd5b1084ced476e67df2a34e04371100fae720f4893321f23c6d /usr/bin/composer /usr/bin/composer

# Run Apache as the owner of the mounted source folder so SuiteCRM can write cache/, custom/ and upload/.
RUN set -eux; \
    (getent group "${APP_GID}" || groupadd -g "${APP_GID}" app); \
    useradd -u "${APP_UID}" -g "${APP_GID}" -M -d /var/www -s /usr/sbin/nologin app
ENV APACHE_RUN_USER=app APACHE_RUN_GROUP=#${APP_GID}

COPY php.ini /usr/local/etc/php/conf.d/zz-suitecrm.ini
RUN sed -ri 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf
