export function runCode(userCode: string): unknown {
  return new Function(userCode)()
}
