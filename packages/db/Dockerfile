FROM postgres:17

# Install pgvector and pg_cron from PGDG apt repository
# The official postgres image ships with the PGDG apt source configured
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-17-pgvector \
        postgresql-17-cron \
    && rm -rf /var/lib/apt/lists/*
