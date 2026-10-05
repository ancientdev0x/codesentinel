def query_orders(cursor, status):
    cursor.execute("SELECT * FROM orders WHERE status = %s", (status,))
    return cursor.fetchall()
