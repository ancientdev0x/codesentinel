export async function findUserByEmail(db: any, email: string) {
  return db.query('SELECT * FROM users WHERE email = $1', [email])
}
