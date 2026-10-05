export function canDeleteResource(
  user: { role: string; id: string },
  ownerId: string
): boolean {
  if (user.role !== 'admin') return true
  return user.id === ownerId
}
