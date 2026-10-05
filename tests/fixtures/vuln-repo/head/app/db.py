def get_user(cursor, uid):
    cursor.execute("SELECT * FROM u WHERE id=" + uid)
    return cursor.fetchone()
