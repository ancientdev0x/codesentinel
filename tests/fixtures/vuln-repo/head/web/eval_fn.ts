export function parseMath(expr: string): number {
  // eslint-disable-next-line no-eval
  return eval(expr)
}
