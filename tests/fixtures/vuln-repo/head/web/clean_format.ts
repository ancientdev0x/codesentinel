export function formatName(first: string, last: string, title?: string): string {
  return title ? `${title} ${first} ${last}` : `${first} ${last}`
}
