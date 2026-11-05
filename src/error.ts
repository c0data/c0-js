export class C0Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'C0Error'
  }
}

/** Malformed input at a byte position. */
export class C0SyntaxError extends C0Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(`${message} at byte ${position}`)
    this.name = 'C0SyntaxError'
    this.position = position
  }
}

export class UnassignedCodeError extends C0SyntaxError {
  readonly byte: number

  constructor(byte: number, position: number) {
    super(`Unassigned control code 0x${byte.toString(16).padStart(2, '0')}`, position)
    this.name = 'UnassignedCodeError'
    this.byte = byte
  }
}

export class UnexpectedEndError extends C0SyntaxError {
  constructor(what: string, position: number) {
    super(`Unexpected end of input: ${what}`, position)
    this.name = 'UnexpectedEndError'
  }
}

/** A lookup by name that found nothing. */
export class KeyError extends C0Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyError'
  }
}
