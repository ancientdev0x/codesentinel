def query_orders(cursor, status):
    cursor.execute(f"SELECT * FROM orders WHERE status = '{status}'")
    return cursor.fetchall()
