# Sample Supply order service

> SAMPLE APPLICATION (test fixture). Sample Supply Co. is a made-up business and every record in
> its database is synthetic. It exists so Goose can show a full upgrade end to end.

Small internal API for orders. The shop front-end and the warehouse scripts call it.

## Run

    pip install -r requirements.txt
    python app.py

Database is `orders.db` in the same folder (set `ORDERS_DB` to use another file).
Create a new one with `sqlite3 orders.db < schema.sql`.

## Notes

- Big orders get a discount (see app.py). Ask Linda if the numbers look wrong.
- Old products were deleted straight from the database in 2023 when we changed suppliers.
- The server clock is on shop time (Chicago).
